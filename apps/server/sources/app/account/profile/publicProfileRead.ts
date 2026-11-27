import type { PublicProfileOwnerReadV1, PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { projectPublicProfile, projectPublicProfileIdentity } from '@happier-dev/protocol/account/projectPublicProfile';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { parsePublicProfileRecord, type PublicProfileServerDependencies } from './publicProfileStorage';
import { readPublicProfilePicture } from './publicProfilePicture';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';
import { createHash } from 'node:crypto';
import { publicProfileSyncedAge } from './render/publicProfileLabels';

export interface PublicProfileDelivery {
    result: PublicProfileReadResultV1;
    picture?: Readonly<{ bytes: Buffer; mimeType: 'image/png'; width: number; height: number }>;
}

interface ResolvedPublicProfile {
    result: PublicProfileReadResultV1;
    accountId?: string;
}

interface ResolvedPublicProfileDelivery extends ResolvedPublicProfile {
    picture?: PublicProfileDelivery['picture'];
}

type ProfileTheme = 'auto' | 'light' | 'dark';
export type PublicProfileRepresentationVariant =
    | Readonly<{ kind: 'html'; service?: string; nowMs?: number }>
    | Readonly<{ kind: 'svg'; surface: 'badge' | 'card'; theme: ProfileTheme; metric?: string }>
    | Readonly<{ kind: 'png'; surface: 'card' | 'og'; theme?: ProfileTheme }>
    | Readonly<{ kind: 'background'; selection?: Readonly<{ theme: 'light' | 'dark'; viewport: 'wide' | 'phone'; density: '1' | '2' }> }>;

interface PublicProfileRepresentationCondition {
    ifNoneMatch: string | string[] | undefined;
    variant: PublicProfileRepresentationVariant;
}

type PublicProfileRepresentation<T> =
    | { kind: 'not_modified'; result: PublicProfileReadResultV1; etag: string }
    | { kind: 'rendered'; result: PublicProfileReadResultV1; representation: T; etag?: string };

export function matchesPublicProfileEtag(value: string | string[] | undefined, etag: string): boolean {
    const values = Array.isArray(value) ? value : [value ?? ''];
    return values.flatMap(value => value.split(',')).some(value => value.trim() === '*'
        || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

/** Bump the rendering revision for semantic renderer/font/copy changes, including the generated HTML body. */
function representationEtag(result: PublicProfileReadResultV1, variant: PublicProfileRepresentationVariant): string | undefined {
    if (result.kind === 'unavailable') return undefined;
    if (variant.kind === 'background' && (result.kind !== 'published'
        || result.view.appearance.atmosphere.source === 'none'
        || (!variant.selection && result.view.appearance.atmosphere.source !== 'picture'))) return undefined;
    // The page says how long ago it synced, so its validator follows that age rather than the serving instant.
    const rendered = variant.kind === 'html' ? { kind: variant.kind, service: variant.service } : variant;
    const age = variant.kind === 'html' && variant.nowMs !== undefined && result.kind === 'published'
        ? [publicProfileSyncedAge(result.view.snapshot.computedAtMs, variant.nowMs)] : [];
    return `W/"public-profile-render-2-${createHash('sha256').update(JSON.stringify([rendered, result, ...age])).digest('hex')}"`;
}

/** Owner recovery remains reachable even when public capability is unavailable. */
export async function readPublicProfileOwner(accountId: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileOwnerReadV1> {
    return inReadSnapshot(async (tx): Promise<PublicProfileOwnerReadV1> => {
        const context = await deps.readPublicationContext(tx, accountId, env);
        const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
        if (!row) return { kind: 'absent', context };
        const record = parsePublicProfileRecord(row);
        if (!record) throw new Error('invalid_stored_content');
        return { kind: 'ready', record, context };
    });
}

/** Public JSON shares the canonical projection without loading private media. */
export async function readPublicProfile(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    return (await resolvePublicProfile(handle, env, deps)).result;
}

/** Server delivery keeps physical media separate from the public JSON projection. */
export async function readPublicProfileDelivery(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileDelivery> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { result: { kind: 'unavailable' } };
    return readAdmittedPublicProfileDelivery(handle, env, deps);
}

/** Admit each finite representation once; matching validators avoid media IO and painting. */
export async function readPublicProfileRepresentation<T>(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies,
    materialize: (result: PublicProfileReadResultV1) => Promise<T>, condition: PublicProfileRepresentationCondition): Promise<PublicProfileRepresentation<T>> {
    return readCurrentRepresentation(handle, env, deps, delivery => materialize(delivery.result), condition, false);
}

export async function readPublicProfileDeliveryRepresentation<T>(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies,
    materialize: (delivery: PublicProfileDelivery) => Promise<T>, condition: PublicProfileRepresentationCondition): Promise<PublicProfileRepresentation<T>> {
    return readCurrentRepresentation(handle, env, deps, materialize, condition, true);
}

async function readCurrentRepresentation<T>(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies,
    materialize: (delivery: PublicProfileDelivery) => Promise<T>, condition: PublicProfileRepresentationCondition,
    includePicture: boolean): Promise<PublicProfileRepresentation<T>> {
    const captured = await resolvePublicProfile(handle, env, deps);
    const etag = representationEtag(captured.result, condition.variant);
    if (etag && matchesPublicProfileEtag(condition.ifNoneMatch, etag)) return { kind: 'not_modified', result: captured.result, etag };
    const delivery: ResolvedPublicProfileDelivery = includePicture ? await materializePublicProfileDelivery(captured) : captured;
    const representation = await materialize({ result: delivery.result, ...(delivery.picture ? { picture: delivery.picture } : {}) });
    return { kind: 'rendered', result: delivery.result, representation, etag: representationEtag(delivery.result, condition.variant) };
}

/** Post-feature admission owns the current publication and its private media custody. */
export async function readAdmittedPublicProfileDelivery(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileDelivery> {
    const delivery = await resolvePublicProfileDelivery(handle, env, deps);
    return { result: delivery.result, ...(delivery.picture ? { picture: delivery.picture } : {}) };
}

async function resolvePublicProfileDelivery(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<ResolvedPublicProfileDelivery> {
    const captured = await inReadSnapshot(tx => resolvePublicProfileInTx(tx, handle, env, deps));
    return materializePublicProfileDelivery(captured);
}

async function materializePublicProfileDelivery(captured: ResolvedPublicProfile): Promise<ResolvedPublicProfileDelivery> {
    if (!captured.accountId || captured.result.kind !== 'published' || captured.result.view.appearance.atmosphere.source !== 'picture') return captured;
    const pictureId = captured.result.view.appearance.atmosphere.picture.ref.id;
    const media = await readPublicProfilePicture({ accountId: captured.accountId, pictureId });
    if (!media.ok) {
        if (media.reason === 'not_found') return { result: { kind: 'unavailable' } };
        throw new Error('public_profile_picture_unavailable');
    }
    return { ...captured, picture: { bytes: Buffer.from(media.bytes), mimeType: media.mimeType,
        width: media.width, height: media.height } };
}

async function resolvePublicProfile(handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<ResolvedPublicProfile> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { result: { kind: 'unavailable' } };
    return inReadSnapshot(tx => resolvePublicProfileInTx(tx, handle, env, deps));
}

async function resolvePublicProfileInTx(tx: Tx, handle: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<ResolvedPublicProfile> {
    const account = await tx.account.findUnique({ where: { username: handle }, select: { id: true } });
    if (!account) return { result: { kind: 'unavailable' } };
    return { result: await readAdmittedPublicProfileInTx(tx, account.id, handle, env, deps), accountId: account.id };
}

/** Captured Account consumers cannot follow a recycled handle to another Account. */
export async function readPublicProfileForAccount(accountId: string, env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    if (!isServerFeatureEnabledForRequest('account.publicProfiles', env)) return { kind: 'unavailable' };
    return inReadSnapshot(async tx => {
        const account = await tx.account.findUnique({ where: { id: accountId }, select: { username: true } });
        if (!account?.username) return { kind: 'unavailable' };
        return readAdmittedPublicProfileInTx(tx, accountId, account.username, env, deps);
    });
}

async function readAdmittedPublicProfileInTx(tx: Tx, accountId: string, handle: string,
    env: NodeJS.ProcessEnv, deps: PublicProfileServerDependencies): Promise<PublicProfileReadResultV1> {
    const row = await tx.accountPublicProfile.findUnique({ where: { accountId } });
    if (!row || row.removedAt || row.state === 'draft') return { kind: 'unavailable' };
    const current = parsePublicProfileRecord(row);
    if (!current?.policy) return { kind: 'unavailable' };
    const context = await deps.readPublicationContext(tx, accountId, env);
    if (row.state === 'paused') {
        const { supporter: _supporter, ...identity } = context.identity;
        return { kind: 'paused', handle, identity: projectPublicProfileIdentity(identity, current.policy) };
    }
    if (!current.snapshot || !current.metadata || !current.layout || !current.appearance) return { kind: 'unavailable' };
    try {
        const view = projectPublicProfile({ context, policy: current.policy, metadata: current.metadata,
            snapshot: current.snapshot, layout: current.layout, appearance: current.appearance, relativePeriod: current.query?.period.relative });
        return view ? { kind: 'published', view } : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
}
