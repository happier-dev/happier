import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { computePluginUiArtifactSha256DigestV1, PluginUiArtifactDigestV1Schema, type PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';

import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from '@/storage/portableQueryChunks';

/**
 * The admitted normalized manifest a daemon-selected (bundled first-party,
 * trusted development, drop-in) host claimed for a release-less Account
 * intent. The digest is computed here, never supplied by the claimant.
 */
export type ReleaseLessDeclarationV1 = Readonly<{
    manifestDigestSha256: PluginUiArtifactDigestV1;
    manifest: ParsedPluginManifestV2;
}>;

export type PluginDeclarationMachineV1 = Readonly<{
    machineId: string;
    machineInstallationId?: string;
}>;

type MachineReleaseLessDeclarationV2 = Readonly<{
    machineId: string;
    machineInstallationId: string;
    declaration: ReleaseLessDeclarationV1;
}>;

/** Versioned replacement of the existing private declaration column, not another registry. */
export type ReleaseLessDeclarationsV2 = Readonly<{
    schemaVersion: 2;
    machines: readonly MachineReleaseLessDeclarationV2[];
    legacyDeclaration: ReleaseLessDeclarationV1 | null;
}>;

export type StoredReleaseLessDeclaration = ReleaseLessDeclarationV1 | ReleaseLessDeclarationsV2;

/**
 * The manifest that currently declares a plugin's Account-scoped
 * contributions (webhooks, automation Events) for one exact version, plus the
 * declaration identity Event definitions bind to: the selected release's
 * archive digest, or the claimed manifest digest of a release-less intent.
 */
export type CurrentPluginDeclarationV1 = Readonly<{
    manifest: ParsedPluginManifestV2;
    declarationDigestSha256: PluginUiArtifactDigestV1;
}>;

type StoredDeclarationIntentRow = Readonly<{
    enabled: boolean;
    desiredVersion: string | null;
    releaseLessDeclaration: unknown;
}>;

/** Projects the already-read Account selection without rereading its immutable declaration. */
export function readCurrentPluginDeclarationV1(params: Readonly<{
    pluginId: string;
    intent: StoredDeclarationIntentRow | null | undefined;
    release: Readonly<{ version: string; normalizedManifest: unknown; archiveDigestSha256: unknown }> | null | undefined;
    machineId?: string;
    machineInstallationId?: string;
}>): CurrentPluginDeclarationV1 | null {
    const { intent, pluginId, release } = params;
    if (!intent?.enabled) return null;
    if (intent.desiredVersion !== null) {
        if (release?.version !== intent.desiredVersion) return null;
        const manifest = readStoredPluginManifestV2(release.normalizedManifest, pluginId);
        const digest = PluginUiArtifactDigestV1Schema.safeParse(release.archiveDigestSha256);
        return manifest?.version === intent.desiredVersion && digest.success
            ? { manifest, declarationDigestSha256: digest.data } : null;
    }
    const declaration = readCurrentReleaseLessDeclarationV1(intent, pluginId,
        params.machineId === undefined ? undefined : { machineId: params.machineId,
            ...(params.machineInstallationId === undefined ? {} : { machineInstallationId: params.machineInstallationId }) });
    return declaration ? { manifest: declaration.manifest, declarationDigestSha256: declaration.manifestDigestSha256 } : null;
}

export function createReleaseLessDeclarationV1(manifest: ParsedPluginManifestV2): ReleaseLessDeclarationV1 {
    return {
        manifestDigestSha256: computePluginUiArtifactSha256DigestV1(
            new TextEncoder().encode(createCanonicalJsonSigningInput(manifest)),
        ),
        manifest,
    };
}

/**
 * Claims and release publication validate and normalize the body before the
 * sole Availability writer stores it. Reads check its identifying envelope;
 * they do not re-admit every contribution in that server-owned body.
 */
export function readStoredPluginManifestV2(stored: unknown, pluginId: string): ParsedPluginManifestV2 | null {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
    const value = stored as Readonly<Record<string, unknown>>;
    if (value.schemaVersion !== 2 || value.id !== pluginId || typeof value.version !== "string"
        || value.contributes === null || typeof value.contributes !== "object" || Array.isArray(value.contributes)) return null;
    // This database boundary reads the normalized output of the validated producer above.
    return stored as ParsedPluginManifestV2;
}

function readReleaseLessDeclarationV1(
    stored: unknown,
    pluginId: string,
): ReleaseLessDeclarationV1 | null {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
    const value = stored as Readonly<Record<string, unknown>>;
    const digest = PluginUiArtifactDigestV1Schema.safeParse(value.manifestDigestSha256);
    const manifest = readStoredPluginManifestV2(value.manifest, pluginId);
    if (!digest.success || !manifest) return null;
    return { manifestDigestSha256: digest.data, manifest };
}

export function readReleaseLessDeclarationsV2(stored: unknown, pluginId: string): ReleaseLessDeclarationsV2 {
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)
        && "schemaVersion" in stored && stored.schemaVersion === 2 && "machines" in stored && Array.isArray(stored.machines)) {
        const machines = stored.machines.flatMap((entry: unknown): MachineReleaseLessDeclarationV2[] => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
            const value = entry as Readonly<Record<string, unknown>>;
            const declaration = readReleaseLessDeclarationV1(value.declaration, pluginId);
            return typeof value.machineId === "string" && typeof value.machineInstallationId === "string" && declaration
                ? [{ machineId: value.machineId, machineInstallationId: value.machineInstallationId, declaration }] : [];
        });
        return { schemaVersion: 2, machines,
            legacyDeclaration: readReleaseLessDeclarationV1("legacyDeclaration" in stored ? stored.legacyDeclaration : null, pluginId) };
    }
    // Supported old daemon/stored-row shape has no Machine provenance. Never assign it one.
    return { schemaVersion: 2, machines: [], legacyDeclaration: readReleaseLessDeclarationV1(stored, pluginId) };
}

/** Merge one authenticated publisher's declaration without choosing between Machines or versions. */
export function mergeReleaseLessDeclarationV2(params: Readonly<{
    stored: unknown;
    declaration: ReleaseLessDeclarationV1;
    publisher?: Readonly<{ machineId: string; installationId: string }>;
}>): Readonly<{ stored: StoredReleaseLessDeclaration; unchanged: boolean }> {
    const store = readReleaseLessDeclarationsV2(params.stored, params.declaration.manifest.id);
    if (!params.publisher) {
        return { stored: store.machines.length === 0 ? params.declaration : { ...store, legacyDeclaration: params.declaration },
            unchanged: store.legacyDeclaration?.manifestDigestSha256 === params.declaration.manifestDigestSha256 };
    }
    const publisher = params.publisher;
    const incumbent = store.machines.find(entry => entry.machineId === publisher.machineId);
    return { stored: { ...store, machines: [
        ...store.machines.filter(entry => entry.machineId !== publisher.machineId),
        { machineId: publisher.machineId, machineInstallationId: publisher.installationId, declaration: params.declaration },
    ].sort((left, right) => left.machineId.localeCompare(right.machineId)) },
    unchanged: incumbent?.machineInstallationId === publisher.installationId
        && incumbent.declaration.manifestDigestSha256 === params.declaration.manifestDigestSha256 };
}

/** The Account-wide projection is derived from the Machine entries at the same owner. */
export function readCurrentMachinePluginDeclarationsV1(
    intent: StoredDeclarationIntentRow | null | undefined,
    pluginId: string,
) {
    if (!intent?.enabled || intent.desiredVersion !== null) return [];
    return readReleaseLessDeclarationsV2(intent.releaseLessDeclaration, pluginId).machines.map(entry => ({
        machineId: entry.machineId,
        machineInstallationId: entry.machineInstallationId,
        declaration: { manifest: entry.declaration.manifest, declarationDigestSha256: entry.declaration.manifestDigestSha256 },
    }));
}

/**
 * The release-less declaration of an intent, only while no release is
 * selected: a present-user release selection always wins over a claim.
 */
export function readCurrentReleaseLessDeclarationV1(
    intent: Readonly<{ desiredVersion: string | null; releaseLessDeclaration: unknown }> | null | undefined,
    pluginId: string,
    machine?: PluginDeclarationMachineV1,
): ReleaseLessDeclarationV1 | null {
    if (!intent || intent.desiredVersion !== null) return null;
    const store = readReleaseLessDeclarationsV2(intent.releaseLessDeclaration, pluginId);
    if (store.machines.length === 0) return store.legacyDeclaration;
    if (machine) {
        return store.machines.find(entry => entry.machineId === machine.machineId
            && (machine.machineInstallationId === undefined || entry.machineInstallationId === machine.machineInstallationId))?.declaration ?? null;
    }
    // An Account-wide single declaration exists only when every Machine agrees.
    const first = store.machines[0]!.declaration;
    return store.machines.every(entry => entry.declaration.manifestDigestSha256 === first.manifestDigestSha256) ? first : null;
}

/** An enabled intent that selects either a portable release or a claimed declaration. */
export function isPluginIntentSelectingDeclarationV1(
    intent: StoredDeclarationIntentRow | null | undefined,
    pluginId: string,
): boolean {
    return intent?.enabled === true
        && (intent.desiredVersion !== null || readReleaseLessDeclarationsV2(intent.releaseLessDeclaration, pluginId).machines.length > 0
            || readCurrentReleaseLessDeclarationV1(intent, pluginId) !== null);
}

function declarationRefKey(pluginId: string, version: string, machineId?: string, machineInstallationId?: string): string {
    return `${pluginId}\0${version}${machineId === undefined ? "" : `\0${machineId}\0${machineInstallationId ?? ""}`}`;
}

/**
 * The one current-declaration reader for Account-scoped plugin contributions.
 * An exact `pluginId@version` is current only while the Account intent is
 * enabled and selects it: through the selected portable release, or, when no
 * release is selected, through the release-less declaration its host claimed.
 * Fixed database work regardless of the number of refs.
 */
export async function resolveCurrentPluginDeclarationsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    refs: readonly Readonly<{ pluginId: string; version: string; machineId?: string; machineInstallationId?: string }>[];
}>): Promise<ReadonlyMap<string, CurrentPluginDeclarationV1>> {
    const resolved = new Map<string, CurrentPluginDeclarationV1>();
    if (params.refs.length === 0) return resolved;
    const pluginIds = [...new Set(params.refs.map((ref) => ref.pluginId))];
    const intents = [];
    for (const ids of portableQueryChunks({ values: pluginIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        intents.push(...await params.tx.accountPluginIntent.findMany({
            where: { accountId: params.accountId, pluginId: { in: [...ids] } },
            select: { pluginId: true, enabled: true, desiredVersion: true, releaseLessDeclaration: true },
        }));
    }
    const intentsByPluginId = new Map(intents.map((intent) => [intent.pluginId, intent] as const));
    const releaseRefs = [...new Map(params.refs.flatMap((ref) => (
        intentsByPluginId.get(ref.pluginId)?.desiredVersion === ref.version
            ? [[declarationRefKey(ref.pluginId, ref.version), ref] as const]
            : []
    ))).values()];
    const releases = [];
    for (const refs of portableQueryChunks({ values: releaseRefs, bindingsPerValue: 2, fixedBindings: 2 })) {
        releases.push(...await params.tx.accountPluginRelease.findMany({
            where: {
                accountId: params.accountId,
                OR: refs.map((ref) => ({ pluginId: ref.pluginId, version: ref.version })),
            },
            select: { pluginId: true, version: true, archiveDigestSha256: true, normalizedManifest: true },
        }));
    }
    const releasesByRef = new Map(releases.map((release) => [
        declarationRefKey(release.pluginId, release.version),
        release,
    ] as const));
    for (const ref of params.refs) {
        const intent = intentsByPluginId.get(ref.pluginId);
        const key = declarationRefKey(ref.pluginId, ref.version, ref.machineId, ref.machineInstallationId);
        const declaration = readCurrentPluginDeclarationV1({ ...ref, intent,
            release: releasesByRef.get(declarationRefKey(ref.pluginId, ref.version)) });
        if (declaration?.manifest.version === ref.version) resolved.set(key, declaration);
    }
    return resolved;
}

export async function resolveCurrentPluginDeclarationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId?: string;
    machineInstallationId?: string;
}>): Promise<CurrentPluginDeclarationV1 | null> {
    const resolved = await resolveCurrentPluginDeclarationsTx({
        tx: params.tx,
        accountId: params.accountId,
        refs: [params],
    });
    return resolved.get(declarationRefKey(params.pluginId, params.version, params.machineId, params.machineInstallationId)) ?? null;
}

export function currentPluginDeclarationKeyV1(pluginId: string, version: string, machineId?: string, machineInstallationId?: string): string {
    return declarationRefKey(pluginId, version, machineId, machineInstallationId);
}
