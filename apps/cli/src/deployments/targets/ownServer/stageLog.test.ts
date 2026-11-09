import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openOwnServerDeploymentStageLog, readOwnServerDeploymentStageLogs } from './stageLog';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './paths';
import { MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES } from '@/plugins/runtime/invocation/services/managedServiceNativeLogBudget';
import { createStablePluginUiResourceWatchOwner } from '@/plugins/runtime/invocation/services/uiResourceWatch';
import { DaemonPluginUiResourceReadRequestSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createHash } from 'node:crypto';

describe('operation-owned deployment stage file', () => {
    it('closes an in-flight open range before later-step bytes and joins only repeated selected-step segments', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-boundary-'));
        try {
            const placement = { deploymentRoot, environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'),
                deploymentId: 'deployment', machineId: 'runtime', installationId: 'installation' };
            const file = await openOwnServerDeploymentStageLog(placement);
            try {
                await file.beginStep({ stepId: 'build' });
                file.appendRedacted('stdout', Buffer.from('build first\n'));
                const receipt = { deployment: { environmentId: 'environment', id: 'deployment' }, content: {
                    buildMachineId: 'runtime', machines: ['runtime'], ownServer: { stageLogs: [file.provenance] },
                } };
                const host = { deploymentRoot, serverId: 'home', machineId: 'runtime', installationId: 'installation' };
                const inFlight = readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build' });
                await file.beginStep({ stepId: 'cleanup' });
                file.appendRedacted('stdout', Buffer.from('cleanup is not build\n'));
                expect(await inFlight).toMatchObject({ kind: 'page', page: { text: 'build first\n' } });
                await file.beginStep({ stepId: 'build' });
                file.appendRedacted('stderr', Buffer.from('build resumed [REDACTED]\n'));
                const current = { ...receipt, content: { ...receipt.content, ownServer: { stageLogs: [file.provenance] } } };
                expect(await readOwnServerDeploymentStageLogs(host, current, { ref: 'build' }))
                    .toMatchObject({ kind: 'page', page: { text: 'build first\nbuild resumed [REDACTED]\n' } });
                const lifetime = new AbortController();
                let release: { dispose(): Promise<void> } | undefined;
                try {
                    const attaching = readOwnServerDeploymentStageLogs(host, current, { ref: 'build', tail: true,
                        observation: { signal: lifetime.signal, emit() {}, accept(value) { release = value; } } });
                    await file.beginStep({ stepId: 'cleanup' });
                    file.appendRedacted('stdout', Buffer.from('later cleanup is not build\n'));
                    expect(await attaching).toMatchObject({ kind: 'page', page: { text: 'build first\nbuild resumed [REDACTED]\n' } });
                } finally { lifetime.abort(); await release?.dispose(); }
            } finally { await file.close(); }
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });

    it('delivers a retained build-stage append through the existing admitted host Resource watch and closes its exact reference', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-resource-'));
        const resourceOwner = createStablePluginUiResourceWatchOwner({ isPluginConsumerCurrent: () => false, readPluginOccurrenceId: () => null });
        try {
            const placement = { deploymentRoot, environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'),
                deploymentId: 'deployment', machineId: 'runtime', installationId: 'installation' };
            const file = await openOwnServerDeploymentStageLog(placement);
            await file.beginStep({ stepId: 'build' });
            file.appendRedacted('stdout', Buffer.from('one [REDACTED]\n'));
            const receipt = { deployment: { environmentId: 'environment', id: 'deployment' }, content: {
                buildMachineId: 'runtime', machines: ['runtime'], ownServer: { stageLogs: [file.provenance] },
            } };
            const host = { deploymentRoot, serverId: 'home', machineId: 'runtime', installationId: 'installation' };
            const initial = await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build', tail: true });
            if (initial.kind !== 'page') throw new Error('Expected retained stage tail');
            const resource = { hostRead: 'deployments.logs' as const, input: { serverId: 'home', machineId: 'runtime', installationId: 'installation',
                environmentId: 'environment', deploymentId: 'deployment', targetLinkId: 'target', kind: 'build' as const, ref: 'build', tail: true as const },
                sourceRevision: initial.page.sourceRevision };
            expect(DaemonPluginUiResourceReadRequestSchema.parse({ machineId: 'runtime', resource })).toEqual({ machineId: 'runtime', resource });
            const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
            await resourceOwner.openHost({ accountId: 'account', subscriptionId: 'build', resource, async bind(signal, emit) {
                let subscription: { dispose(): Promise<void> } | undefined;
                const value = await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build', tail: true,
                    observation: { signal, emit: page => emit(digest(page)), accept: value => { subscription = value; } } });
                if (!subscription) throw new Error('Expected sink watch');
                return { digest: digest(value), dispose: () => subscription!.dispose() };
            } });
            file.appendRedacted('stdout', Buffer.from('two [REDACTED]\n'));
            const request = { hostAccountId: 'account', subscriptionId: 'build', resource };
            const event = await resourceOwner.next(request);
            expect(event).toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            if (event.status !== 'event' || event.event.kind !== 'invalidated') throw new Error('Expected pushed resource edge');
            const page = await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build', tail: true });
            expect(event.event.digest).toBe(digest(page));
            expect(await resourceOwner.close({ ...request, resource: { ...resource, input: { ...resource.input, ref: 'other-step' } } })).toBe(false);
            expect(await resourceOwner.close(request)).toBe(true);
            await file.close();
        } finally { resourceOwner.retire(); await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('pushes only changed selected-step masked tails after reopen, with no polling or unrelated-step delivery', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-follow-'));
        try {
            const placement = { deploymentRoot, environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'),
                deploymentId: 'deployment', machineId: 'runtime', installationId: 'installation' };
            const first = await openOwnServerDeploymentStageLog(placement);
            await first.beginStep({ stepId: 'build' });
            first.appendRedacted('stdout', Buffer.from('before restart [REDACTED]\n'));
            const receipt = { deployment: { environmentId: 'environment', id: 'deployment' }, content: {
                buildMachineId: 'runtime', machines: ['runtime'], ownServer: { stageLogs: [first.provenance] },
            } };
            await first.close();
            const controller = new AbortController();
            const pages: unknown[] = [];
            let release: { dispose(): Promise<void> } | undefined;
            const initial = await readOwnServerDeploymentStageLogs({ deploymentRoot, serverId: 'home', machineId: 'runtime', installationId: 'installation' },
                receipt, { ref: 'build', tail: true, observation: { signal: controller.signal,
                    emit: value => { pages.push(value); }, accept: value => { release = value; } } });
            expect(initial).toMatchObject({ kind: 'page', page: { text: 'before restart [REDACTED]\n' } });
            expect(release).toBeDefined();
            const reopened = await openOwnServerDeploymentStageLog({ ...placement, expected: first.provenance });
            await reopened.beginStep({ stepId: 'build' });
            reopened.appendRedacted('stderr', Buffer.from('after restart [REDACTED]\n'));
            await vi.waitFor(() => expect(pages).toHaveLength(1));
            expect(pages[0]).toMatchObject({ kind: 'page', page: { text: 'before restart [REDACTED]\nafter restart [REDACTED]\n' } });
            await reopened.beginStep({ stepId: 'cleanup' });
            for (let i = 0; i < 100; i++) reopened.appendRedacted('stdout', Buffer.from('unrelated cleanup\n'));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(pages).toHaveLength(1);
            controller.abort();
            await release?.dispose();
            await reopened.beginStep({ stepId: 'build' });
            reopened.appendRedacted('stdout', Buffer.from('closed consumer\n'));
            await reopened.close();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(pages).toHaveLength(1);
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('associates masked bytes with step refs, pages only that step and retains the association after reopen', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-refs-'));
        try {
            const placement = { deploymentRoot, environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment'),
                deploymentId: 'deployment', machineId: 'runtime', installationId: 'installation' };
            const changes: unknown[] = [];
            const file = await openOwnServerDeploymentStageLog({ ...placement, onProvenance: async value => { changes.push(value); } });
            await file.beginStep({ stepId: 'source' });
            file.appendRedacted('stdout', Buffer.from('source [REDACTED]\n'));
            await file.beginStep({ stepId: 'build' });
            await file.beginStep({ stepId: 'build' }); // Same phase is not another publication.
            const build = `${'猫'.repeat(3000)}build [REDACTED]\n`;
            file.appendRedacted('stderr', Buffer.from(build));
            await file.beginStep({ stepId: 'cleanup' });
            file.appendRedacted('stdout', Buffer.from('cleanup only\n'));
            const provenance = file.provenance;
            await file.close();
            expect(changes).toHaveLength(3);
            expect(provenance.steps).toEqual([
                { ref: 'source', range: { start: 0, end: Buffer.byteLength('source [REDACTED]\n') } },
                { ref: 'build', range: { start: Buffer.byteLength('source [REDACTED]\n'),
                    end: Buffer.byteLength(`source [REDACTED]\n${build}`) } },
                { ref: 'cleanup', range: { start: Buffer.byteLength(`source [REDACTED]\n${build}`), end: null } },
            ]);
            const receipt = { deployment: { environmentId: 'environment', id: 'deployment' }, content: {
                buildMachineId: 'runtime', machines: ['runtime'], ownServer: { stageLogs: [provenance] },
            } };
            const host = { deploymentRoot, serverId: 'home', machineId: 'runtime', installationId: 'installation' };
            const first = await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build' });
            expect(first.kind).toBe('page');
            if (first.kind !== 'page') throw new Error('Expected selected step page');
            expect(Buffer.byteLength(first.page.text)).toBeLessThanOrEqual(MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES);
            expect(first.page.truncated).toBe(true);
            const second = await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'build', cursor: first.page.nextCursor! });
            expect(second.kind).toBe('page');
            if (second.kind !== 'page') throw new Error('Expected selected step continuation');
            expect(first.page.text + second.page.text).toBe(build);
            expect(second.page.truncated).toBe(false);
            expect(await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'missing' }))
                .toMatchObject({ kind: 'unavailable', reason: 'admission_unavailable' });
            expect(await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'source', cursor: first.page.nextCursor! }))
                .toMatchObject({ kind: 'source-changed' });
            const reopened = await openOwnServerDeploymentStageLog({ ...placement, expected: provenance });
            await reopened.beginStep({ stepId: 'cleanup' });
            reopened.appendRedacted('stdout', Buffer.from('after restart\n'));
            await reopened.close();
            expect(await readOwnServerDeploymentStageLogs(host, receipt, { ref: 'cleanup' }))
                .toMatchObject({ kind: 'page', page: { text: 'cleanup only\nafter restart\n' } });
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('carries a bounded masked excerpt in the same receipt provenance without reopening its file', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-excerpt-'));
        try {
            const file = await openOwnServerDeploymentStageLog({ deploymentRoot, environmentInstanceId: 'instance',
                deploymentId: 'receipt', machineId: 'builder', installationId: 'installation' });
            try {
                file.appendRedacted('stdout', Buffer.from('masked [REDACTED]\n'));
                expect(file.provenance).toMatchObject({ excerpt: { text: 'masked [REDACTED]\n', truncated: false } });
                file.appendRedacted('stderr', Buffer.from(`${'猫'.repeat(9000)}failure [REDACTED]`));
                const excerpt = file.provenance.excerpt;
                if (!excerpt) throw new Error('Expected a masked stage-log excerpt');
                expect(excerpt).toMatchObject({ truncated: true });
                expect(Buffer.byteLength(excerpt.text)).toBeLessThanOrEqual(MANAGED_SERVICE_NATIVE_LOG_PAGE_BYTES);
                expect(excerpt.text).not.toContain('\uFFFD');
                expect(excerpt.text).toMatch(/failure \[REDACTED\]$/u);
            } finally { await file.close(); }
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('pages UTF-8 bytes including BOM, follows appends after reopen, and refuses rotation or cancellation', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-reader-'));
        try {
            const instance = resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment');
            const placement = { deploymentRoot, environmentInstanceId: instance, deploymentId: 'deployment',
                machineId: 'runtime', installationId: 'installation', async assertCurrent() {} };
            const file = await openOwnServerDeploymentStageLog(placement);
            const text = `\uFEFF${'a'.repeat(8188)}猫 after`;
            file.appendRedacted('stdout', Buffer.from(text)); file.assertWritten();
            const host = { deploymentRoot, serverId: 'home', machineId: placement.machineId, installationId: placement.installationId };
            const receipt = { deployment: { environmentId: 'environment', id: 'deployment' }, content: {
                buildMachineId: 'historical-builder', machines: ['runtime'], ownServer: { stageLogs: [file.provenance] },
            } };
            const first = await readOwnServerDeploymentStageLogs(host, receipt);
            expect(await readOwnServerDeploymentStageLogs({ ...host, serverId: 'other-home' }, receipt))
                .toMatchObject({ kind: 'unavailable' });
            expect(first.kind).toBe('page');
            if (first.kind !== 'page') throw new Error('Expected admitted stage page');
            expect(first.page.text).toBe(`\uFEFF${'a'.repeat(8188)}`);
            expect(first.page.truncated).toBe(true);
            const second = await readOwnServerDeploymentStageLogs(host, receipt, { cursor: first.page.nextCursor! });
            expect(second.kind).toBe('page');
            if (second.kind !== 'page') throw new Error('Expected UTF-8 continuation');
            expect(second.page.text).toBe('猫 after');
            await file.close();
            const resumed = await openOwnServerDeploymentStageLog({ ...placement, expected: file.provenance });
            resumed.appendRedacted('stderr', Buffer.from(' PORT=3000 [REDACTED]\n')); await resumed.close();
            const tail = await readOwnServerDeploymentStageLogs(host, receipt, { cursor: second.page.nextCursor! });
            expect(tail).toMatchObject({ kind: 'page', page: { text: ' PORT=3000 [REDACTED]\n', truncated: false } });
            const path = join(deploymentRoot, instance, 'releases', 'deployment', '.happier', 'deploy.log');
            if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
            await rename(path, `${path}.retained`);
            await writeFile(path, text, { mode: 0o600 });
            // Retained placement authorizes this private stage file. Its
            // inode is a cursor-rotation fact, not another persisted authority.
            const rotated = await openOwnServerDeploymentStageLog({ ...placement, expected: file.provenance });
            rotated.appendRedacted('stdout', Buffer.from(' after rotation')); await rotated.close();
            expect(await readOwnServerDeploymentStageLogs(host, receipt, { cursor: second.page.nextCursor! }))
                .toMatchObject({ kind: 'source-changed' });
            expect(await readOwnServerDeploymentStageLogs(host, receipt))
                .toMatchObject({ kind: 'page', page: { text: `\uFEFF${'a'.repeat(8188)}` } });
            const cancellation = new AbortController(); cancellation.abort();
            await expect(readOwnServerDeploymentStageLogs(host, receipt, { signal: cancellation.signal })).rejects.toThrow();
            expect(await readOwnServerDeploymentStageLogs({ ...host, installationId: 'replacement' }, receipt))
                .toMatchObject({ kind: 'unavailable' });
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('refuses a missing receipt-owned log without creating a replacement file', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-missing-'));
        try {
            const instance = resolveOwnServerDeploymentEnvironmentInstanceIdForHost('home', 'environment');
            const placement = { deploymentRoot, environmentInstanceId: instance, deploymentId: 'deployment',
                machineId: 'runtime', installationId: 'installation', async assertCurrent() {} };
            const file = await openOwnServerDeploymentStageLog(placement);
            file.appendRedacted('stdout', Buffer.from('retained redacted bytes')); await file.close();
            const directory = join(deploymentRoot, instance, 'releases', 'deployment', '.happier');
            await rename(join(directory, 'deploy.log'), join(directory, 'retained.log'));
            await expect(openOwnServerDeploymentStageLog({ ...placement, expected: file.provenance })).rejects.toThrow();
            expect(await readdir(directory)).toEqual(['retained.log']);
            expect(await readFile(join(directory, 'retained.log'), 'utf8')).toBe('retained redacted bytes');
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
    it('never chmods or writes into an existing foreign release without a retained placement', async () => {
        const deploymentRoot = await mkdtemp(join(tmpdir(), 'happier-stage-foreign-'));
        try {
            const release = join(deploymentRoot, 'environment', 'releases', 'deployment');
            await mkdir(release, { recursive: true, mode: 0o755 });
            await writeFile(join(release, 'foreign'), 'foreign bytes');
            const mode = (await stat(release)).mode;
            await expect(openOwnServerDeploymentStageLog({ deploymentRoot, environmentInstanceId: 'environment',
                deploymentId: 'deployment', machineId: 'machine', installationId: 'installation' }))
                .rejects.toThrow();
            expect((await stat(release)).mode).toBe(mode);
            expect(await readdir(release)).toEqual(['foreign']);
            expect(await readFile(join(release, 'foreign'), 'utf8')).toBe('foreign bytes');
        } finally { await rm(deploymentRoot, { recursive: true, force: true }); }
    });
});
