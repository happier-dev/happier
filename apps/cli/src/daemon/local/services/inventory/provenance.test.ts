import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCAL_SERVICE_CAPABILITIES } from '@happier-dev/protocol';

import {
    isWorkspacePathWithin,
    matchWorkspaceAssociation,
    recoverProcessLineageFacts,
    redactProcessCommand,
} from './provenance';

describe('isWorkspacePathWithin', () => {
    it('treats a path as within its own root and nested children', () => {
        expect(isWorkspacePathWithin('/repo/web', '/repo/web')).toBe(true);
        expect(isWorkspacePathWithin('/repo/web', '/repo/web/src')).toBe(true);
        expect(isWorkspacePathWithin('/repo/web', '/repo/other')).toBe(false);
    });

    it('is Windows-safe: drive-letter case-fold, trailing separators, mixed separators', () => {
        expect(isWorkspacePathWithin('C:\\Users\\alice\\proj', 'c:/users/alice/proj/src')).toBe(true);
        expect(isWorkspacePathWithin('C:\\Users\\alice\\proj\\', 'C:\\Users\\alice\\proj')).toBe(true);
    });

    it('guards against sibling-prefix collisions', () => {
        expect(isWorkspacePathWithin('C:\\Users\\alice', 'C:\\Users\\alice2')).toBe(false);
        expect(isWorkspacePathWithin('/repo/web', '/repo/web2')).toBe(false);
    });
});

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

    // Every provider-key family the inventory capability `redactsProcessArgs: true`
    // implies must be redacted in any position (bare positional, flag value, env value).
    // The token bodies below are well-known public placeholder formats, never real secrets.
    it.each([
        ['AWS access-key id (AKIA)', 'AKIAIOSFODNN7EXAMPLE'],
        ['AWS temporary access-key id (ASIA)', 'ASIAIOSFODNN7EXAMPLE'],
        ['Google API key (AIza)', 'AIzaSyA00000000000000000000000000000000'],
        ['Hugging-Face token (hf_)', 'hf_0000000000000000000000000000000000'],
        ['npm token (npm_)', 'npm_000000000000000000000000000000000000'],
    ])('redacts a %s in a bare positional argument', (_label, token) => {
        const redacted = redactProcessCommand(`node server.js ${token}`);

        expect(redacted).not.toContain(token);
        expect(redacted).toContain('[REDACTED]');
    });

    it.each([
        ['AWS access-key id (AKIA)', 'AKIAIOSFODNN7EXAMPLE'],
        ['Google API key (AIza)', 'AIzaSyA00000000000000000000000000000000'],
        ['Hugging-Face token (hf_)', 'hf_0000000000000000000000000000000000'],
        ['npm token (npm_)', 'npm_000000000000000000000000000000000000'],
    ])('redacts a %s passed as a flag value', (_label, token) => {
        const redacted = redactProcessCommand(`node server.js --key ${token}`);

        expect(redacted).not.toContain(token);
        expect(redacted).toContain('[REDACTED]');
    });

    it.each([
        ['AWS access-key id (AKIA)', 'AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE'],
        ['Google API key (AIza)', 'GOOGLE_API_KEY', 'AIzaSyA00000000000000000000000000000000'],
        ['Hugging-Face token (hf_)', 'HUGGINGFACE', 'hf_0000000000000000000000000000000000'],
        ['npm token (npm_)', 'NPM', 'npm_000000000000000000000000000000000000'],
    ])('redacts a %s in a plain (non secret-named) env assignment value', (_label, name, token) => {
        const redacted = redactProcessCommand(`${name}=${token} node server.js`);

        expect(redacted).not.toContain(token);
        expect(redacted).toContain('[REDACTED]');
    });

    it('leaves non-secret arguments (paths, ports, plain flags) untouched', () => {
        const command = 'node /srv/app/server.js --port 5173 --host 127.0.0.1 --watch ./src';

        const redacted = redactProcessCommand(command);

        expect(redacted).toBe(command);
        expect(redacted).not.toContain('[REDACTED]');
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

    it('keeps a generic listener command when ancestors are unrelated shells or supervisors', () => {
        const result = recoverProcessLineageFacts({
            listenerPid: 62376,
            maxDepth: 4,
            processes: new Map([
                [62376, {
                    pid: 62376,
                    ppid: 300,
                    command: 'python3 -m http.server 62376 --bind 127.0.0.1',
                    cwd: '/repo/app',
                }],
                [300, { pid: 300, ppid: 200, command: 'zsh', cwd: '/repo/app' }],
                [200, { pid: 200, ppid: 1, command: 'codex app-server --listen stdio://', cwd: '/repo/app' }],
                [1, { pid: 1, command: '/sbin/launchd' }],
            ]),
        });

        expect(result.command).toBe('python3 -m http.server 62376 --bind 127.0.0.1');
        expect(result.cwd).toBe('/repo/app');
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

describe('redactsProcessArgs capability is earned', () => {
    // The protocol advertises `redactsProcessArgs: true` for the detected inventory. This
    // pins that the advertised bit is backed by real redaction for every provider-key
    // family the claim implies — a regression that drops any prefix (or silently flips the
    // bit off) fails here. Placeholders below are public well-known token formats.
    const ADVERTISED_PROVIDER_TOKENS: readonly string[] = [
        'sk-live-0000000000000000',
        'ghp_0000000000000000000000000000000000',
        'glpat-00000000000000000000',
        'xoxb-0000000000-0000000000-000000000000',
        'AKIAIOSFODNN7EXAMPLE',
        'ASIAIOSFODNN7EXAMPLE',
        'AIzaSyA00000000000000000000000000000000',
        'hf_0000000000000000000000000000000000',
        'npm_000000000000000000000000000000000000',
    ];

    it('still advertises redactsProcessArgs: true', () => {
        expect(DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.redactsProcessArgs).toBe(true);
    });

    it('redacts every advertised provider-key family when the bit is true', () => {
        expect(DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.redactsProcessArgs).toBe(true);
        for (const token of ADVERTISED_PROVIDER_TOKENS) {
            const redacted = redactProcessCommand(`node server.js ${token}`);
            expect(redacted, `expected ${token} to be redacted`).not.toContain(token);
            expect(redacted).toContain('[REDACTED]');
        }
    });
});
