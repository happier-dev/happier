import type * as React from 'react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Metro/Expo owns this context, including module evaluation and async mode.
const context = { load: vi.fn<(key: string) => unknown>() };

import { workspaceRouteBodies } from './workspaceRouteBodies';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';
import { workspaceRouteFiles } from './workspaceRoutes';

const Body: React.ComponentType = () => null;
const appRoot = fileURLToPath(new URL('../../../app/', import.meta.url));

beforeEach(() => {
    context.load.mockReset();
    registerWorkspaceRouteContext(context.load);
});

describe('workspace loading through the canonical Expo context', () => {
    it.each(['overview', 'code', 'changes', 'scripts', 'services', 'context'])('hosts the canonical Project %s page through its Expo body', async (page) => {
        const key = `projects/[workspaceRefId]/${page}`;
        context.load.mockImplementation((moduleKey) => {
            if (moduleKey !== `./(app)/projects/[workspaceRefId]/${page}.tsx`) throw new Error('wrong Project page requested');
            return { WorkspaceRouteBody: Body };
        });
        expect(workspaceRouteBodies[key]).toBeTypeOf('function');
        await expect(workspaceRouteBodies[key]!()).resolves.toEqual({ default: Body });
    });

    it('has no unpublished Project alias module producers', () => {
        for (const alias of ['details', 'files', 'git']) {
            expect(workspaceRouteFiles[`projects/[workspaceRefId]/${alias}`]).toBeUndefined();
        }
    });
    it('uses existing, platform-neutral route identities', () => {
        for (const key of Object.values(workspaceRouteFiles)) {
            const file = resolve(appRoot, key);
            expect(existsSync(file), key).toBe(true);
            // Current workspace routes have no platform-specific siblings. If
            // that changes, use Expo's selected route identity, not this key.
            for (const platform of ['web', 'native', 'ios', 'android']) {
                expect(existsSync(file.replace(/\.tsx$/, `.${platform}.tsx`)), key).toBe(false);
            }
        }
    });

    it.each(['settings', 'artifacts'])('hosts every %s leaf exported by the registered app tree', (directory) => {
        const root = appRoot;
        const leaves: string[] = [];
        function visit(directory: string) {
            for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
                const key = `${directory}/${entry.name}`;
                if (entry.isDirectory()) visit(key);
                else if (entry.name.endsWith('.tsx') && !entry.name.startsWith('_') && !/\.(test|spec)\./.test(entry.name)) {
                    expect(readFileSync(resolve(root, key), 'utf8'), key).toContain('WorkspaceRouteBody');
                    leaves.push(`./${key}`);
                }
            }
        }
        visit(`(app)/${directory}`);
        expect(leaves.filter(key => !Object.values(workspaceRouteFiles).includes(key))).toEqual([]);
    });

    it.each(['sync', 'async'] as const)('uses the same named body in %s context mode', async (mode) => {
        context.load.mockImplementation((key) => {
            if (key !== './(app)/settings/index.tsx') throw new Error('unrequested route evaluated');
            const module = { WorkspaceRouteBody: Body };
            return mode === 'sync' ? module : Promise.resolve(module);
        });
        await expect(workspaceRouteBodies.settings!()).resolves.toEqual({ default: Body });
    });

    it('retains the directory-index module identity rather than inventing a file key', async () => {
        context.load.mockImplementation((key) => {
            if (key !== './(app)/settings/account/api-tokens/index.tsx') throw new Error('wrong module identity');
            return { WorkspaceRouteBody: Body };
        });
        await expect(workspaceRouteBodies['settings/account/api-tokens']!()).resolves.toEqual({ default: Body });
    });

    it.each([undefined, {}, { WorkspaceRouteBody: null }])('rejects an unavailable body instead of loading a second route', async (module) => {
        context.load.mockReturnValue(module);
        await expect(workspaceRouteBodies.settings!()).rejects.toBeInstanceOf(Error);
    });

    it('preserves the context failure for the existing rendering error boundary', async () => {
        const failure = new Error('module evaluation failed');
        context.load.mockRejectedValue(failure);
        await expect(workspaceRouteBodies.settings!()).rejects.toBe(failure);
    });
});
