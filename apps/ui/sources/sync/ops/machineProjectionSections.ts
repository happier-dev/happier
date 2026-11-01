import { DaemonContributionRegistryProjectionSectionsResponseSchema, reassembleDaemonProjectionSections,
    DaemonProjectionSectionBodyResponseSchema, computeDaemonProjectionSectionDigest, demandedDaemonProjectionSections,
    DAEMON_PROJECTION_SECTION_STALE_CODE, type DaemonProjectionDeferredSectionsResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { parseDaemonContributionRegistryProjectionDescribeResponse } from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import { RpcError } from '@/sync/runtime/rpcErrors';
import type { DaemonProjectionHydrationRejection } from './machineContributionRegistryProjection';

export type DeferredDaemonProjection = Readonly<{
    manifest: DaemonProjectionDeferredSectionsResponse;
    loadedSections: readonly string[];
}>;
export class InvalidDaemonProjectionSection extends Error {
    constructor(readonly reason: DaemonProjectionHydrationRejection) { super(reason); }
}

/** Account/locale-qualified bytes only; each Machine still admits its own manifest. */
export type DaemonProjectionSectionCache = Readonly<{
    bodies: Map<string, readonly string[]>;
    pendingReads: Map<string, Promise<readonly string[] | undefined>>;
}>;

export async function readDeferredProjection(params: Readonly<{
    manifest: DaemonProjectionDeferredSectionsResponse;
    sections?: readonly string[];
    held: ReadonlyMap<string, readonly string[]>;
    shared?: DaemonProjectionSectionCache;
    signal?: AbortSignal;
    read(digest: string, offset: number, includeDigests: readonly string[]): Promise<unknown>;
}>) {
    const bodies = new Map<string, readonly string[]>();
    const pendingReads = params.shared?.pendingReads ?? new Map<string, Promise<readonly string[] | undefined>>();
    const json = (text: string): unknown => {
        try { return JSON.parse(text); } catch { throw new InvalidDaemonProjectionSection('section-json'); }
    };
    const readBody = async (digest: string, includeDigests: readonly string[], frame: boolean,
        revealIncluded: (repack: boolean) => void): Promise<readonly string[]> => {
        const chunks: string[] = [];
        let offset = 0;
        for (;;) {
            const response = await params.read(digest, offset, offset === 0 ? includeDigests : []);
            if (response && typeof response === 'object' && 'errorCode' in response
                && response.errorCode === DAEMON_PROJECTION_SECTION_STALE_CODE) {
                throw new RpcError('Projection section is no longer current', DAEMON_PROJECTION_SECTION_STALE_CODE);
            }
            const admitted = DaemonProjectionSectionBodyResponseSchema.safeParse(response);
            if (!admitted.success) throw new InvalidDaemonProjectionSection('section-page');
            const page = admitted.data;
            if (page.digest !== digest || page.offset !== offset || !page.chunk.length
                || (page.nextOffset !== null && page.nextOffset !== offset + page.chunk.length)) throw new InvalidDaemonProjectionSection('section-page-position');
            chunks.push(page.chunk);
            for (const extra of page.bodies ?? []) {
                if (!includeDigests.includes(extra.digest) || computeDaemonProjectionSectionDigest(extra.body) !== extra.digest) {
                    throw new InvalidDaemonProjectionSection('included-section');
                }
                bodies.set(extra.digest, extra.body);
                params.shared?.bodies.set(extra.digest, extra.body);
            }
            // The first frame has answered the peer inclusion question. An
            // omitted digest can start now, independently of this body's pages.
            if (offset === 0) revealIncluded(page.nextOffset === null || Boolean(page.bodies?.length));
            if (page.nextOffset === null) break;
            offset = page.nextOffset;
        }
        const value = frame && params.manifest.sectionFrameVersion === 2 ? [chunks.join('')] : json(chunks.join(''));
        if (!Array.isArray(value) || !value.every((span): span is string => typeof span === 'string')) {
            throw new InvalidDaemonProjectionSection('section-spans');
        }
        if (computeDaemonProjectionSectionDigest(value) !== digest) throw new InvalidDaemonProjectionSection('section-digest');
        bodies.set(digest, value);
        params.shared?.bodies.set(digest, value);
        return value;
    };
    const body = async (digest: string, includeDigests: readonly string[] = [], frame = false): Promise<readonly string[]> => {
        const held = () => bodies.get(digest) ?? params.shared?.bodies.get(digest) ?? params.held.get(digest);
        let previous = held();
        if (previous) { bodies.set(digest, previous); return previous; }
        let pending = pendingReads.get(digest);
        while (pending) {
            try {
                previous = await pending;
                if (previous) { bodies.set(digest, previous); return previous; }
            } catch (error) {
                // A peer's failed/cancelled byte read is not this Machine's
                // authority. Its live consumer can read the same digest here.
                if (params.signal?.aborted) throw error;
            }
            previous = held();
            if (previous) { bodies.set(digest, previous); return previous; }
            const successor = pendingReads.get(digest);
            // Omitted peers wake together. Join the reader that has already
            // replaced the inclusion claim instead of dispatching a duplicate.
            if (successor === pending) break;
            pending = successor;
        }
        const shared = params.shared;
        const candidates = includeDigests.filter(peer => !bodies.has(peer) && !params.held.has(peer)
            && !shared?.bodies.has(peer) && !pendingReads.has(peer));
        // Claim included bodies before dispatch too. The frame budget may
        // omit a candidate; its waiters then read it through their own Machine.
        let revealIncluded!: (repack: boolean) => void;
        const firstPage = new Promise<boolean>(resolve => { revealIncluded = resolve; });
        const read = Promise.resolve().then(() => readBody(digest, candidates, frame, revealIncluded));
        // Failed/cancelled issuers also release peers to their own live reader.
        void read.then(() => revealIncluded(false), () => revealIncluded(false));
        const claims = new Map<string, Promise<readonly string[] | undefined>>([[digest, read]]);
        for (const peer of candidates) {
            const included = firstPage.then(repack => {
                // The first page has settled this inclusion claim. Release it
                // before omitted waiters resume so their next frame can pack
                // the remaining peers instead of dispatching one read each.
                // A completed or peer-packing frame can batch small peers
                // again. If none fit beside an unfinished carrier, keep the
                // omitted large bodies independent rather than serializing them.
                if (repack && pendingReads.get(peer) === included) pendingReads.delete(peer);
                return bodies.get(peer);
            });
            claims.set(peer, included);
        }
        for (const [key, claim] of claims) pendingReads.set(key, claim);
        try { return await read; }
        finally {
            for (const [key, claim] of claims) {
                if (pendingReads.get(key) === claim) pendingReads.delete(key);
            }
        }
    };
    const projection: Record<string, unknown> = { installedPackagesById: {}, agentsById: {}, actionsById: {},
        resourcesById: {}, settingsById: {}, familiesById: {} };
    const response: Record<string, unknown> = { projection };
    const loadedSections = demandedDaemonProjectionSections(params.manifest, params.sections);
    const indexDigests = loadedSections.map(section => params.manifest.sections[section]!);
    const frames = new Map(await Promise.all(loadedSections.map(async section => {
        const digest = params.manifest.sections[section]!;
        const index = await body(digest, indexDigests.filter(peer => peer !== digest), true);
        if (index.length !== 1) throw new InvalidDaemonProjectionSection('section-index');
        const admitted = DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse(json(index[0]!));
        if (!admitted.success) throw new InvalidDaemonProjectionSection('section-index-schema');
        return [section, admitted.data] as const;
    })));
    // Indexes disclose the body demand. Gather across every selected section
    // before awaiting a body so the existing wire-frame owner can include peers.
    const digests = [...new Set([...frames.values()].flatMap(frame => frame.parts.flatMap(part => typeof part === 'string' ? [] : [part.digest])))];
    await Promise.all(digests.map(digest => body(digest,
        digests.filter(peer => peer !== digest && !bodies.has(peer) && !params.held.has(peer)))));
    for (const [section, framed] of frames) {
        const assembled = reassembleDaemonProjectionSections(framed, bodies);
        if (!assembled || !assembled.response || typeof assembled.response !== 'object' || Array.isArray(assembled.response)) throw new InvalidDaemonProjectionSection('section-assembly');
        const fragment = assembled.response as Record<string, unknown>;
        const keysAre = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(value
            && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
            && keys.every(key => Object.hasOwn(value, key)));
        const validFragment = section === 'base'
            ? keysAre(fragment, ['protocolVersion', 'projectionDigest', 'projection'])
                && keysAre(fragment.projection, ['v', 'generation', 'diagnostics'])
            : section.startsWith('familiesById.')
                ? keysAre(fragment, ['projection']) && keysAre(fragment.projection, ['familiesById'])
                    && keysAre(fragment.projection.familiesById, [section.slice('familiesById.'.length)])
                : keysAre(fragment, ['projection']) ? keysAre(fragment.projection, [section]) : keysAre(fragment, [section]);
        if (!validFragment) throw new InvalidDaemonProjectionSection('section-identity');
        for (const [key, value] of Object.entries(fragment)) {
            if (key !== 'projection') Object.defineProperty(response, key, { value, enumerable: true, configurable: true });
            else {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidDaemonProjectionSection('section-projection');
                for (const [field, child] of Object.entries(value)) Object.defineProperty(projection, field, {
                    value: field === 'familiesById' ? { ...(projection.familiesById as object), ...(child as object) } : child,
                    enumerable: true, configurable: true,
                });
            }
        }
    }
    const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
    if (!parsed || parsed.projectionDigest !== params.manifest.projectionDigest) throw new InvalidDaemonProjectionSection('projection-admission');
    return { ...parsed, sectionBodies: bodies, deferredProjection: { manifest: params.manifest, loadedSections } };
}
