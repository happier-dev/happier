import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { seedCurrentLocalPathPluginFixture } from '../../../plugins/store/registry/currentState.testkit.ts';
import { loadInstalledPlugins } from '../../../plugins/discovery/load/installed.ts';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry.ts';
import { projectLoadedPluginContributes } from '../../../plugins/projection/registry/resolvePluginContributions.ts';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts';

// A real installed package, immutable generation and fresh source-loader
// process keep module-cache state and internal mocks out of this regression.
const happyHomeDir = process.env.HAPPIER_HOME_DIR;
assert(happyHomeDir);
const pluginId = 'acme.idle-plugin';
const pluginRoot = join(happyHomeDir, 'fixture-plugin');
const logPath = join(happyHomeDir, 'activation.log');
function assertJsonEqual(actual, expected, message) {
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}
await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify({
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Idle plugin',
    engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
    contributes: {
        agents: [{ id: 'fixture-agent', title: 'Fixture Agent', primary: 'sessions',
            runtime: { kind: 'acp', transport: { kind: 'tcp', host: '127.0.0.1', port: 4242 } },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
        resources: [
            { id: 'status', source: 'dynamic', kind: 'config', contentType: 'text/plain' },
            { id: 'instructions', source: 'dynamic', kind: 'prompt', contentType: 'text/plain' },
        ],
        promptAssets: [{ id: 'guidance', kind: 'guidelines', resource: 'instructions',
            target: { kind: 'agent', agent: 'fixture-agent' } }],
        composerReferences: [{ id: 'issues', title: 'Issues', icon: 'search', triggers: ['@'] }],
        actions: [{ id: 'inspect', title: 'Inspect', scopes: ['global'], surfaces: ['cli'],
            execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe' }],
    },
}));
await writeFile(join(pluginRoot, 'daemon.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(logPath)}, 'import\\n');
export function activate(api) {
    appendFileSync(${JSON.stringify(logPath)}, 'activate\\n');
    api.resources.registerDynamicResource('status', {
        async read() { return 'ready'; }, observe() { return { dispose() {} }; },
    });
    api.resources.registerDynamicResource('instructions', {
        async read() {
            const control = globalThis.__HAPPIER_IDLE_PLUGIN_RESOURCE_CONTROL__;
            if (control) { control.started(); await control.wait; }
            return 'Prompt context.';
        }, observe() { return { dispose() {} }; },
    });
    api.composerReferences.register('issues', {
        async search() { return [{ id: 'issue:1', label: 'Issue one' }]; },
        async resolve(id) { return { id, label: 'Issue one', context: 'Issue context' }; },
    });
    api.actions.register('inspect', async (_input, context) => ({
        size: context.services.resources.describe('status').size,
        instructionSize: context.services.resources.describe('instructions').size,
    }));
}
`);
await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
const startupId = 'acme.startup-plugin';
const startupRoot = join(happyHomeDir, 'startup-plugin');
const startupLogPath = join(happyHomeDir, 'startup.log');
await mkdir(join(startupRoot, '.happier-plugin'), { recursive: true });
await writeFile(join(startupRoot, '.happier-plugin/plugin.json'), JSON.stringify({
    schemaVersion: 2, id: startupId, version: '1.0.0', displayName: 'Startup plugin',
    engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' }, activation: { events: [{ kind: 'startup' }] },
    contributes: {},
}));
await writeFile(join(startupRoot, 'daemon.mjs'), `
import { appendFileSync } from 'node:fs';
export function activate() { appendFileSync(${JSON.stringify(startupLogPath)}, 'startup\\n'); }
`);
await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot: startupRoot, pluginId: startupId, manifestVersion: '1.0.0' });
const loaded = await loadInstalledPlugins({ happyHomeDir });
assert(loaded.loadedPlugins.some(plugin => plugin.pluginId === pluginId), JSON.stringify(loaded.diagnosticsByPluginId));
const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
    loadResult: loaded, provenance: 'external', existingAgentIds: new Set(),
}));
const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes });
let releaseResource = () => {};
try {
    assert.equal(await readFile(logPath, 'utf8').catch(() => ''), '', 'Idle composition imported or activated an undemanded installed plugin');
    assert.equal(runtime.activatedPluginIds.has(pluginId), false);
    assert.equal(await readFile(startupLogPath, 'utf8'), 'startup\n', 'Explicit startup activation was deferred');
    const reference = { pluginId, localId: 'issues' };
    assertJsonEqual(runtime.composerReferences.list(), [reference], 'Cold declarations disappeared from the Composer inventory');
    // Invalid demand must not import the package.
    await assert.rejects(runtime.composerReferences.search({ reference: { pluginId, localId: 'undeclared' },
        query: 'issue', trigger: '@', signal: new AbortController().signal }), { code: 'composer_reference_unavailable' });
    const occurrenceId = runtime.contributes.occurrenceIdsByPluginId[pluginId];
    assert(occurrenceId, 'Cold installed declaration has no admitted occurrence');
    await assert.rejects(runtime.readUiResource({ callerPluginId: pluginId,
        expectedCallerOccurrenceId: 'retired-occurrence', resourceId: 'status' }), { code: 'plugin_generation_stale' });
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(runtime.readUiResource({ callerPluginId: pluginId,
        expectedCallerOccurrenceId: 'retired-occurrence', resourceId: 'status', signal: cancellation.signal }),
    { code: 'plugin_generation_stale' });
    await assert.rejects(runtime.readUiResource({ callerPluginId: pluginId,
        expectedCallerOccurrenceId: occurrenceId, resourceId: 'status', signal: cancellation.signal }),
    { code: 'plugin_resource_aborted' });
    assert.equal(await readFile(logPath, 'utf8').catch(() => ''), '');
    if (process.argv[2] === 'concurrentResourceAction') {
        let markStarted;
        const started = new Promise(resolve => { markStarted = resolve; });
        const wait = new Promise(resolve => { releaseResource = resolve; });
        globalThis.__HAPPIER_IDLE_PLUGIN_RESOURCE_CONTROL__ = { started: markStarted, wait };
        const agent = runtime.contributes.agents.find(candidate => candidate.pluginId === pluginId);
        assert(agent);
        const preparing = runtime.resolvePromptAssetBlocks({ agentId: agent.id,
            selectedAsset: { pluginId, localId: 'guidance' } });
        await started;
        let settled = false;
        const action = runtime.targetActionInvocations.invoke({ pluginId, localId: 'inspect', surface: 'cli', input: {} })
            .then(result => { settled = true; return result; });
        const actionCancellation = new AbortController();
        const cancelledAction = runtime.targetActionInvocations.invoke({ pluginId, localId: 'inspect',
            surface: 'cli', input: {}, signal: actionCancellation.signal });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'A warm Action bypassed the in-flight global Resource admission');
        actionCancellation.abort();
        releaseResource();
        await preparing;
        const cancelledResult = await cancelledAction;
        assert.equal(cancelledResult.status, 'unavailable', JSON.stringify(cancelledResult));
        assert.equal(cancelledResult.code, 'plugin_action_aborted');
        assert.equal(cancelledResult.actionHandlerInvocation, 'notStarted');
        const result = await action;
        assert.equal(result.status, 'executed', JSON.stringify(result));
    } else if (process.argv[2] === 'composerReferences') {
        assertJsonEqual(await runtime.composerReferences.search({ reference, query: 'issue', trigger: '@',
            signal: new AbortController().signal }), [{ id: 'issue:1', label: 'Issue one' }]);
    } else if (process.argv[2] === 'resourceWatch') {
        const watch = await runtime.openUiResourceWatch({ callerPluginId: pluginId,
            expectedCallerOccurrenceId: occurrenceId, resourceId: 'status', subscriptionId: 'idle-fixture' });
        assert(watch.digest.startsWith('sha256:'));
        assert.equal(runtime.closeUiResourceWatch({ callerPluginId: pluginId,
            expectedCallerOccurrenceId: occurrenceId, subscriptionId: watch.subscriptionId }), true);
    } else if (process.argv[2] === 'promptAssets') {
        const agent = runtime.contributes.agents.find(candidate => candidate.pluginId === pluginId);
        assert(agent);
        const blocks = await runtime.resolvePromptAssetBlocks({ agentId: agent.id,
            selectedAsset: { pluginId, localId: 'guidance' } });
        assert(blocks.some(block => block.text === 'Prompt context.'), 'Cold dynamic prompt Resource was omitted');
    } else {
        const first = await runtime.readUiResource({ callerPluginId: pluginId,
            expectedCallerOccurrenceId: occurrenceId, resourceId: 'status' });
        assert.equal(new TextDecoder().decode(first.bytes), 'ready');
    }
    assert.equal(runtime.readPluginOccurrenceId(pluginId), occurrenceId);
    const inspected = await runtime.targetActionInvocations.invoke({ pluginId, localId: 'inspect', surface: 'cli', input: {} });
    assert.equal(inspected.status, 'executed', JSON.stringify(inspected));
    assertJsonEqual(inspected.value, { size: 5, instructionSize: 15 }, 'First demand failed to prepare synchronous Resource descriptors');
    const result = await runtime.readUiResource({ callerPluginId: pluginId,
        expectedCallerOccurrenceId: occurrenceId, resourceId: 'status' });
    assert.equal(new TextDecoder().decode(result.bytes), 'ready');
    assertJsonEqual(await runtime.composerReferences.search({ reference, query: 'issue', trigger: '@',
        signal: new AbortController().signal }), [{ id: 'issue:1', label: 'Issue one' }]);
    assertJsonEqual(await runtime.composerReferences.resolve({ reference, candidateId: 'issue:1',
        signal: new AbortController().signal }), { id: 'issue:1', label: 'Issue one', context: 'Issue context' });
    assert.equal(await readFile(logPath, 'utf8'), 'import\nactivate\n', 'Repeated demands reactivated an installed occurrence');
    process.stdout.write('Installed plugin stayed cold and supplied Resource, synchronous descriptor, and Composer operations on demand.\n');
} finally {
    releaseResource();
    delete globalThis.__HAPPIER_IDLE_PLUGIN_RESOURCE_CONTROL__;
    await runtime.dispose();
}
process.exit(0);
