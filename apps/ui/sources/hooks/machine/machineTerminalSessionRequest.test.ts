import { describe, expect, it } from 'vitest';
import { buildMachineTerminalSessionRequest } from './machineTerminalSessionRequest';

describe('terminal hook request', () => {
    it('retains the admitted Project workspace on ensure and restart without inventing Session attribution', () => {
        const workspace = { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const request = buildMachineTerminalSessionRequest({ terminalKey: 'project-terminal', cwd: workspace.rootPath, workspace });
        expect(request).toMatchObject({ workspace, cwd: '/accepted' });
        expect(request).not.toHaveProperty('sessionId');
        expect(request).not.toHaveProperty('requesterAccountId');
    });
    it('preserves the selected package cwd with the canonical script launch on ensure and restart', () => {
        const request = buildMachineTerminalSessionRequest({
            terminalKey: 'session:address:home:session:terminal:script', cwd: 'C:\\repo\\web', cols: 80, rows: 24,
            launch: { kind: 'package_script', runTargetId: 'web:dev' },
        });
        expect(request).toMatchObject({ cwd: 'C:\\repo\\web', launch: { kind: 'package_script', runTargetId: 'web:dev' } });
        expect(request).not.toHaveProperty('initialCommand');
        expect(buildMachineTerminalSessionRequest({ terminalKey: 'shell', cwd: '/repo', initialCommand: 'echo selected' }))
            .toMatchObject({ cwd: '/repo', initialCommand: 'echo selected' });
        expect(buildMachineTerminalSessionRequest({ terminalKey: 'attach', cwd: null, launch: { kind: 'session_attach', sessionId: 'session' } }))
            .not.toHaveProperty('cwd');
    });
});
