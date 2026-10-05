import type { WorkBoardArtifactTransportV1, WorkBoardArtifactRevisionV1, WorkBoardArtifactV1 } from '../boards/workBoardArtifactV1.js';
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { HomeHubLayoutIntentSchema, normalizeHomeHubLayoutV1, HOME_HUB_DEFAULT_LAYOUT, HOME_HUB_BUILTIN_DEFINITIONS,
    applyHomeHubLayoutIntent, buildHomeHubLayoutResult, captureHomeHubWidgetPresentationV1, HomeHubMutationErrorV1,
    type HomeHubLayoutIntent, type HomeHubLayoutValue, type HomeHubWidgetInput, type HomeHubBuiltinDefinition, type HomeHubWidgetPresentationV1 } from './homeHubLayoutV1.js';

export const HOME_HUB_ARTIFACT_KIND_V1 = 'home-hub-layout.v1';
// Artifact ids are globally unique UUIDs in a Home database. UUID v5 gives this Account one
// singleton without Settings, inventory scans or another identity store. This namespace is fixed.
const homeLayoutNamespace = new Uint8Array([0x78, 0x60, 0xee, 0x57, 0x7a, 0xbb, 0x48, 0xa1, 0x98, 0x0b, 0xe5, 0x0c, 0xc0, 0xe3, 0x99, 0x78]);
export function buildHomeHubArtifactIdV1(accountId: string): string {
    if (!accountId.trim()) throw new HomeHubMutationErrorV1('home_hub_account_unavailable');
    const bytes = sha1(concatBytes(homeLayoutNamespace, new TextEncoder().encode(accountId))).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type HomeHubArtifactV1 = WorkBoardArtifactV1 & Readonly<{ ownerAccountId: string }>;
export type HomeHubArtifactTransportV1 = Pick<WorkBoardArtifactTransportV1, 'create' | 'update'> & Readonly<{
    read(artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<HomeHubArtifactV1 | null>;
}>;
export type HomeHubLayoutResultV1 = ReturnType<typeof buildHomeHubLayoutResult>;
export type HomeHubArtifactPortV1 = Readonly<{
    read(signal?: AbortSignal): Promise<HomeHubLayoutValue>;
    apply(intent: HomeHubLayoutIntent, signal?: AbortSignal): Promise<HomeHubLayoutResultV1>;
    describe(layout: HomeHubLayoutValue, signal?: AbortSignal): Promise<HomeHubLayoutResultV1>;
    captureWidgetPresentation(layout: HomeHubLayoutValue, instanceId: string, signal?: AbortSignal): Promise<HomeHubWidgetPresentationV1>;
}>;

function open(artifact: WorkBoardArtifactV1): HomeHubLayoutValue {
    if (artifact.header.kind !== HOME_HUB_ARTIFACT_KIND_V1 || artifact.header.v !== 1 || typeof artifact.body !== 'string') throw new HomeHubMutationErrorV1('invalid_home_hub_record');
    try { return normalizeHomeHubLayoutV1(JSON.parse(artifact.body)); }
    catch { return HOME_HUB_DEFAULT_LAYOUT; }
}
const header = { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1, title: 'Home layout' };

/** Account-mode admission and encryption belong to the incumbent Account Artifact transport. */
export function createHomeHubArtifactPortV1(transport: HomeHubArtifactTransportV1, options: Readonly<{
    accountId: string;
    shouldContinue?: () => boolean;
    builtins?: readonly HomeHubBuiltinDefinition[];
    readWidgets?: (signal?: AbortSignal) => readonly HomeHubWidgetInput[] | Promise<readonly HomeHubWidgetInput[]>;
    onLayout?: (layout: HomeHubLayoutValue, revision?: WorkBoardArtifactRevisionV1) => void;
}>): HomeHubArtifactPortV1 {
    const artifactId = buildHomeHubArtifactIdV1(options.accountId);
    const check = (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (options.shouldContinue && !options.shouldContinue()) throw new HomeHubMutationErrorV1('home_hub_scope_retired');
    };
    const widgets = async (signal?: AbortSignal) => { check(signal); const value = await options.readWidgets?.(signal) ?? []; check(signal); return value; };
    const fetch = async (signal?: AbortSignal) => {
        check(signal);
        const value = await transport.read(artifactId, { signal });
        check(signal);
        if (value && (value.artifactId !== artifactId || value.ownerAccountId !== options.accountId)) throw new HomeHubMutationErrorV1('home_hub_account_mismatch');
        return value;
    };
    const accept = (layout: HomeHubLayoutValue, revision?: WorkBoardArtifactRevisionV1, signal?: AbortSignal) => {
        if (!signal?.aborted && (!options.shouldContinue || options.shouldContinue())) options.onLayout?.(layout, revision);
        return layout;
    };
    const builtins = options.builtins ?? HOME_HUB_BUILTIN_DEFINITIONS;
    return {
        async read(signal) {
            const artifact = await fetch(signal);
            return accept(artifact ? open(artifact) : HOME_HUB_DEFAULT_LAYOUT, artifact?.revision);
        },
        async describe(layout, signal) { return buildHomeHubLayoutResult(layout, builtins, await widgets(signal)); },
        async captureWidgetPresentation(layout, instanceId, signal) {
            return captureHomeHubWidgetPresentationV1(layout, builtins, await widgets(signal), instanceId);
        },
        async apply(rawIntent, signal) {
            const intent = HomeHubLayoutIntentSchema.parse(rawIntent);
            for (;;) {
                const artifact = await fetch(signal);
                const current = artifact ? open(artifact) : HOME_HUB_DEFAULT_LAYOUT;
                const evidence = await widgets(signal);
                const next = applyHomeHubLayoutIntent(current, builtins, evidence, intent);
                const complete = (layout: HomeHubLayoutValue, revision?: WorkBoardArtifactRevisionV1) =>
                    buildHomeHubLayoutResult(accept(layout, revision, signal), builtins, evidence);
                if (next === current) return complete(current, artifact?.revision);
                check(signal);
                if (!artifact) {
                    try { await transport.create({ artifactId, header, body: JSON.stringify(next), signal }); }
                    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'conflict')) throw error; }
                    const acknowledged = await fetch(signal);
                    if (!acknowledged) throw new HomeHubMutationErrorV1('invalid_home_hub_record');
                    const winner = open(acknowledged);
                    if (sameStrictJsonValue(winner, next)) return complete(winner, acknowledged.revision);
                    // Another client created the singleton first: replay against its authoritative content.
                    continue;
                }
                const result = await transport.update({ artifactId,
                    expectedRevision: artifact.revision, header: { ...artifact.header, ...header }, body: JSON.stringify(next), signal });
                // The transport acknowledgment remains true even if its Account retired while awaiting it.
                if (result.ok) return complete(next, result.revision);
                if (result.errorCode !== 'version_mismatch') throw new HomeHubMutationErrorV1(result.errorCode);
                check(signal);
            }
        },
    };
}
