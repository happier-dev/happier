import { describe, expect, it } from 'vitest';

import {
    matchWorkspaceAssociation,
    recoverProcessLineageFacts,
    redactProcessCommand,
} from './provenance';

describe('redactProcessCommand', () => {
    it('redacts common command-line secrets before projection', () => {
        const command = 'npm run dev -- --token abc123 --api-key=sk-live-secret -p password Bearer raw-token';

        const redacted = redactProcessCommand(command);

        expect(redacted).not.toContain('abc123');
        expect(redacted).not.toContain('sk-live-secret');
        expect(redacted).not.toContain('raw-token');
        expect(redacted).toContain('[REDACTED]');
    });

    it('redacts inline secret environment assignments before projection', () => {
        const command = 'MY_TOKEN=raw-env-token OPENAI_API_KEY=plain-key npm run dev';

        const redacted = redactProcessCommand(command);

        expect(redacted).not.toContain('raw-env-token');
        expect(redacted).not.toContain('plain-key');
        expect(redacted).toContain('MY_TOKEN=[REDACTED]');
        expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
    });
});

describe('recoverProcessLineageFacts', () => {
    it('recovers meaningful ancestor command and cwd for generic listener children', () => {
        const result = recoverProcessLineageFacts({
            listenerPid: 400,
            maxDepth: 4,
            processes: new Map([
                [400, { pid: 400, ppid: 300, command: 'node /tmp/vite/bin/vite.js', cwd: '/repo/app/node_modules/vite' }],
                [300, { pid: 300, ppid: 200, command: 'npm run dev -- --token secret-token', cwd: '/repo/app' }],
                [200, { pid: 200, ppid: 1, command: 'zsh', cwd: '/repo/app' }],
            ]),
        });

        expect(result.command).toBe('npm run dev -- --token [REDACTED]');
        expect(result.pid).toBe(400);
        expect(result.ppid).toBe(300);
        expect(result.lineagePids).toEqual([400, 300, 200]);
        expect(result.cwd).toBe('/repo/app');
        expect(result.redacted).toBe(true);
    });

    it('stops bounded lineage walking on cycles', () => {
        const result = recoverProcessLineageFacts({
            listenerPid: 10,
            maxDepth: 8,
            processes: new Map([
                [10, { pid: 10, ppid: 11, command: 'node server.js', cwd: '/repo' }],
                [11, { pid: 11, ppid: 10, command: 'npm run dev', cwd: '/repo' }],
            ]),
        });

        expect(result.command).toBe('npm run dev');
    });
});

describe('matchWorkspaceAssociation', () => {
    it('treats cwd containment as high-confidence workspace association without process ownership', () => {
        const result = matchWorkspaceAssociation({
            cwd: '/repo/app',
            workspaces: [{ id: 'workspace-a', path: '/repo' }],
        });

        expect(result).toEqual({
            workspace: {
                id: 'workspace-a',
                path: '/repo',
                association: 'cwd_containment',
            },
            workspaceAssociationConfidence: 'high',
        });
    });
});
