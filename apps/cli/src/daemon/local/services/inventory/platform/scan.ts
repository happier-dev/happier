import { readFile, readdir, readlink } from 'node:fs/promises';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

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

/**
 * The single platform boundary used by inventory and managed endpoint detection.
 *
 * darwin (`lsof`/`ps`) and windows (`netstat`/`powershell`) run through `execFileWithDeadline`
 * rather than a `child_process` `timeout`, which reports a killed scan as a SUCCESS with empty
 * stdout on a stalled loop — indistinguishable from "nothing is listening". Linux reads `/proc`
 * and spawns nothing, so it has never been exposed to it.
 */
export async function scanPlatformLocalServices(): Promise<LocalServicesScanResult> {
    if (process.platform === 'darwin') {
        const result = await readDarwinLocalServiceListeners({
            execFile: execFileWithDeadline,
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
            execFile: execFileWithDeadline,
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
