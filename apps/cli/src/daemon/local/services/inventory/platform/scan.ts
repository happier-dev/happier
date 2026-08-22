import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

import type {
    LocalServiceInventoryDiagnostic,
    LocalServiceListenerFact,
} from '../scanner';
import type {
    LocalServiceProcessFact,
    LocalServiceWorkspaceFact,
} from '../provenance';
import { readDarwinLocalServiceListeners } from './darwin';
import { readLinuxLocalServiceListeners } from './linux';
import { readWindowsLocalServiceListeners } from './windows';

export type LocalServicesScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    workspaces: readonly LocalServiceWorkspaceFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

/** The single platform boundary used by inventory and managed endpoint detection. */
export async function scanPlatformLocalServices(): Promise<LocalServicesScanResult> {
    if (process.platform === 'darwin') {
        const result = await readDarwinLocalServiceListeners({
            execFile: promisify(execFile),
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    if (process.platform === 'win32') {
        const result = await readWindowsLocalServiceListeners({
            execFile: promisify(execFile),
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    const result = await readLinuxLocalServiceListeners({
        readFile,
        readdir,
        readlink,
    });
    return {
        listeners: result.listeners,
        processes: result.processes,
        workspaces: [],
        diagnostics: result.diagnostics,
    };
}
