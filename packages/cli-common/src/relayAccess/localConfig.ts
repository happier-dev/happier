import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '@happier-dev/protocol/common/records';
import type { AccessProviderRouteV1, AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';

export type LocalRelayAccessConfig = Readonly<{ selection: AccessProviderSelectionV1; route?: AccessProviderRouteV1 }>;

/** The Relay install config and the signed-in Machine read the same host record. */
export async function readLocalRelayAccessConfig(homeDir: string): Promise<LocalRelayAccessConfig | null> {
    const raw = await readFile(join(homeDir, 'relay', 'access', 'local.json'), 'utf8').catch(() => '');
    if (!raw.trim()) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!isRecord(value)) return null;
    const { AccessProviderRouteV1Schema, AccessProviderSelectionV1Schema } =
        await import('@happier-dev/protocol/plugins/contributions/accessProviders');
    const { route, ...input } = value;
    const selection = AccessProviderSelectionV1Schema.safeParse(input);
    if (!selection.success) return null;
    const parsedRoute = route === undefined ? null : AccessProviderRouteV1Schema.safeParse(route);
    if (parsedRoute?.success === false) return null;
    return { selection: selection.data, ...(parsedRoute ? { route: parsedRoute.data } : {}) };
}

export async function writeLocalRelayAccessConfig(homeDir: string, config: LocalRelayAccessConfig | null): Promise<void> {
    const dir = join(homeDir, 'relay', 'access');
    const path = join(dir, 'local.json');
    if (!config) {
        await rm(path, { force: true });
        return;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(dir, '.local-'));
    try {
        const draftPath = join(temporary, 'local.json');
        await writeFile(draftPath, `${JSON.stringify({ ...config.selection, ...(config.route ? { route: config.route } : {}) }, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 });
        await rename(draftPath, path);
    } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
}
