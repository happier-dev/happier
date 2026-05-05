import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PluginReloadStateSnapshot = Readonly<{
    t: 'happier_plugin_reload_state_v1';
    schemaVersion: 1;
    generation: number;
    activeGenerationId: string;
    changedPluginIds: readonly string[];
    updatedAt: number;
}>;

function statePath(happyHomeDir: string): string {
    return join(happyHomeDir, 'plugins', 'reload', 'state.v1.json');
}

function isSnapshot(value: unknown): value is PluginReloadStateSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record.t === 'happier_plugin_reload_state_v1'
        && record.schemaVersion === 1
        && typeof record.generation === 'number'
        && Number.isInteger(record.generation)
        && record.generation >= 0
        && typeof record.activeGenerationId === 'string'
        && record.activeGenerationId.trim().length > 0
        && Array.isArray(record.changedPluginIds)
        && record.changedPluginIds.every((pluginId) => typeof pluginId === 'string')
        && typeof record.updatedAt === 'number';
}

export async function readPluginReloadStateSnapshot(
    happyHomeDir: string,
): Promise<PluginReloadStateSnapshot | null> {
    try {
        const raw = await readFile(statePath(happyHomeDir), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return isSnapshot(parsed) ? parsed : null;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return null;
        }
        return null;
    }
}

export async function writePluginReloadStateSnapshot(
    happyHomeDir: string,
    snapshot: PluginReloadStateSnapshot,
): Promise<void> {
    const path = statePath(happyHomeDir);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}
