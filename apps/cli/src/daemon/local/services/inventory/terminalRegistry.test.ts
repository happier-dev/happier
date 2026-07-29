import { describe, expect, it } from 'vitest';

import { normalizeLocalServiceScan } from './scanner';
import { createTerminalProcessRegistry } from './terminalRegistry';

describe('createTerminalProcessRegistry', () => {
    it('looks up a registered pid with its workspace + session + terminal attribution', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            sessionId: 'session-a',
            terminalId: 'term-a',
        });

        expect(registry.lookupByPid(400)).toEqual({
            workspacePath: '/repo/web',
            sessionId: 'session-a',
            terminalId: 'term-a',
        });
        expect(registry.lookupByPid(999)).toBeNull();
    });

    it('replaces a terminalKey pid set on re-register (never unions)', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            terminalId: 'term-a',
        });
        // Relaunched service: same terminalKey, new pid + run identity.
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [777],
            terminalId: 'term-a2',
        });

        expect(registry.lookupByPid(400)).toBeNull();
        expect(registry.lookupByPid(777)?.workspacePath).toBe('/repo/web');
    });

    it('identity-checked unregister: a stale OLDER-run exit does not drop a NEWER run', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            terminalId: 'run-1',
        });
        // restart() re-claims the same terminalKey for a new run.
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [410],
            terminalId: 'run-2',
        });

        // Late exit of the OLD run must be a no-op (does not own the stored record).
        registry.unregister({ terminalKey: 't-a', terminalId: 'run-1' });
        expect(registry.lookupByPid(410)?.workspacePath).toBe('/repo/web');
        // re-register already dropped run-1's pid 400.
        expect(registry.lookupByPid(400)).toBeNull();

        // Only the owning run can remove its record.
        registry.unregister({ terminalKey: 't-a', terminalId: 'run-2' });
        expect(registry.lookupByPid(410)).toBeNull();
    });

    it('isolates registrations by terminalKey/workspace', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            sessionId: 'session-a',
            terminalId: 'term-a',
        });
        registry.registerTerminalProcesses({
            terminalKey: 't-b',
            workspacePath: '/other/app',
            pids: [500],
            sessionId: 'session-b',
            terminalId: 'term-b',
        });

        expect(registry.lookupByPid(500)).toEqual({
            workspacePath: '/other/app',
            sessionId: 'session-b',
            terminalId: 'term-b',
        });
        expect(registry.lookupByPid(400)?.workspacePath).toBe('/repo/web');
    });

    it('skips empty pid sets without indexing bogus pids', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [0, Number.NaN, -1],
            terminalId: 'term-a',
        });

        expect(registry.lookupByPid(0)).toBeNull();
        expect(registry.lookupByPid(-1)).toBeNull();
    });
});

describe('normalizeLocalServiceScan + terminalRegistry', () => {
    it('stamps a registered listener pid at high confidence with process_tree association + session attribution', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            sessionId: 'session-a',
            terminalId: 'term-a',
        });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 3_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            // Listener's own cwd does NOT resolve to a workspace: registry path must still win.
            processes: new Map([[400, { pid: 400, ppid: 1, command: 'node vite', cwd: '/tmp/elsewhere' }]]),
            workspaces: [{ id: 'workspace-a', path: '/repo' }],
            terminalRegistry: registry,
        });

        expect(snapshot.entries).toHaveLength(1);
        const entry = snapshot.entries[0];
        expect(entry?.provenance?.workspace).toEqual({
            path: '/repo/web',
            association: 'process_tree',
        });
        expect(entry?.workspaceAssociationConfidence).toBe('high');
        expect(entry?.provenance?.session).toEqual({ id: 'session-a' });
    });

    it('stamps via a lineage pid even when the listener pid itself is not registered', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [300],
            sessionId: 'session-a',
            terminalId: 'term-a',
        });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 3_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([
                [400, { pid: 400, ppid: 300, command: 'node vite', cwd: '/tmp/elsewhere' }],
                [300, { pid: 300, ppid: 1, command: 'npm run dev', cwd: '/repo/web' }],
            ]),
            workspaces: [],
            terminalRegistry: registry,
        });

        const entry = snapshot.entries[0];
        expect(entry?.provenance?.workspace?.path).toBe('/repo/web');
        expect(entry?.provenance?.workspace?.association).toBe('process_tree');
        expect(entry?.provenance?.session).toEqual({ id: 'session-a' });
    });

    it('falls back to cwd_containment with no session attribution after unregister', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-a',
            workspacePath: '/repo/web',
            pids: [400],
            sessionId: 'session-a',
            terminalId: 'term-a',
        });
        registry.unregister({ terminalKey: 't-a', terminalId: 'term-a' });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 3_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, { pid: 400, ppid: 1, command: 'node vite', cwd: '/repo/web' }]]),
            workspaces: [{ id: 'workspace-a', path: '/repo' }],
            terminalRegistry: registry,
        });

        const entry = snapshot.entries[0];
        expect(entry?.provenance?.workspace?.association).toBe('cwd_containment');
        expect(entry?.provenance?.session).toBeUndefined();
    });

    it('leaves session attribution absent when registered without a sessionId', () => {
        const registry = createTerminalProcessRegistry();
        registry.registerTerminalProcesses({
            terminalKey: 't-c',
            workspacePath: '/repo/api',
            pids: [600],
            terminalId: 'term-c',
        });

        const snapshot = normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 3_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 8000, protocol: 'tcp', pid: 600 }],
            processes: new Map([[600, { pid: 600, ppid: 1, command: 'python app', cwd: '/tmp/elsewhere' }]]),
            workspaces: [],
            terminalRegistry: registry,
        });

        const entry = snapshot.entries[0];
        expect(entry?.provenance?.workspace?.path).toBe('/repo/api');
        expect(entry?.workspaceAssociationConfidence).toBe('high');
        expect(entry?.provenance?.session).toBeUndefined();
    });
});
