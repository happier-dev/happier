import {
    definePlugin,
    type ProjectNativeRefV1,
    type ProjectEnvironmentSelectionV1,
    type PluginProjectNativeAdapterRuntimeV1,
} from '@happier-dev/plugin-sdk';
import {
    isPluginActionApprovalRequestCreated,
    type ActionsService,
    type PluginActionInputById,
} from '@happier-dev/plugin-sdk/actions';

export const pixiAdapter = { pluginId: 'acme.pixi-native', localId: 'native-pixi' } as const;
export const importedPixiTask: ProjectNativeRefV1 = {
    kind: 'pluginNative', adapter: pixiAdapter, file: 'pixi.toml', target: 'check',
};
export const importedPixiEnvironment: ProjectEnvironmentSelectionV1 = {
    kind: 'pluginToolchain', adapter: pixiAdapter, configPath: 'pixi.toml',
};

/** This fixture models a distinct native dialect using only the public SDK. */
export const pixiRuntime: PluginProjectNativeAdapterRuntimeV1 = {
    async detect(request) {
        const config = request.files.find(file => file.file === 'pixi.toml');
        return {
            entries: config?.content.includes('check =') ? [{ source: { kind: 'pluginNative', adapter: request.adapter, file: config.file, target: 'check' }, usage: 'script' }] : [],
            environments: config ? [{ kind: 'pluginToolchain', adapter: request.adapter, configPath: config.file }] : [],
            devcontainers: [], coverage: 'complete', diagnostics: [],
        };
    },
    async resolveCommand(request) {
        const config = request.files.find(file => file.file === request.source.file);
        if (!config || request.source.target !== 'check') return { kind: 'unavailable', code: 'pixi_task_not_found' };
        return {
            kind: 'resolved', executable: { kind: 'systemTool', id: 'pixi' }, args: ['run', request.source.target],
            cwd: request.root, reviewInputs: [config], environmentApplied: { kind: 'pluginToolchain', adapter: request.adapter, configPath: request.source.file },
        };
    },
    async produceEnvironment(request) {
        const config = request.files.find(file => file.file === request.selection.configPath);
        if (!config) return { kind: 'unavailable', code: 'pixi_config_not_found' };
        if (!request.launch) return { kind: 'unsupported', code: 'pixi_environment_requires_launch' };
        return {
            kind: 'ready', env: request.launch.env, reviewInputs: [config],
            launch: { executable: { kind: 'systemTool', id: 'pixi' }, args: ['run', '--', request.launch.command, ...request.launch.args], cwd: request.launch.cwd, reviewInputs: [config] },
        };
    },
};

export const pixiPlugin = definePlugin({
    id: pixiAdapter.pluginId, version: '1.0.0', displayName: 'Pixi native definitions',
    entrypoints: { daemon: './daemon.js' },
    hostAccess: { required: [{ id: 'native-config', capability: 'filesystem', reason: 'Read selected native config',
        scope: { locations: [{ root: 'workspace', pathPrefix: 'pixi.toml' }], access: ['read'] } }], optional: [] },
    systemTools: { pixi: { title: 'Pixi', executableNames: ['pixi'] } },
    projectNativeAdapters: {
        [pixiAdapter.localId]: { declaration: { files: ['pixi.toml'], roles: ['detect', 'resolveCommand', 'produceEnvironment'] }, runtime: pixiRuntime },
    },
});

export const persistedQualifiedArms = JSON.stringify({
    version: 1,
    scripts: { check: { source: importedPixiTask } },
    environment: importedPixiEnvironment,
});

/** Acceptance gives custody on the actual Machine; it does not mean the script finished. */
export async function runPixiScriptAndReadOutput(
    actions: ActionsService,
    input: Omit<PluginActionInputById['projects.script.run'], 'selection'>,
) {
    const run = await actions.execute('projects.script.run', {
        ...input, selection: { kind: 'native', source: importedPixiTask },
    });
    if (isPluginActionApprovalRequestCreated(run) || !('operation' in run)) return { run };
    const operation = {
        serverId: input.workspace.serverId,
        machineId: run.operation.scope.machineId,
        operationId: run.operation.operationId,
    };
    const output = await actions.execute('projects.execution.output.read', { ...operation, byteOffset: 0 });
    return { run, output };
}

export async function preparePixiProject(actions: ActionsService, input: PluginActionInputById['projects.prepare']) {
    return await actions.execute('projects.prepare', input);
}

export async function startPixiService(actions: ActionsService, input: PluginActionInputById['localServices.launcher.start']) {
    return await actions.execute('localServices.launcher.start', input);
}

export async function stopPixiService(actions: ActionsService, input: PluginActionInputById['localServices.actions.stopManaged']) {
    return await actions.execute('localServices.actions.stopManaged', input);
}

export async function restartPixiService(actions: ActionsService, input: PluginActionInputById['localServices.actions.restartManaged']) {
    return await actions.execute('localServices.actions.restartManaged', input);
}

export async function createPixiPrivatePreview(actions: ActionsService, input: PluginActionInputById['localServices.preview.openOrCreate']) {
    return await actions.execute('localServices.preview.openOrCreate', input);
}

export async function readPixiPublicPreview(actions: ActionsService, input: PluginActionInputById['localServices.publicPreview.status']) {
    return await actions.execute('localServices.publicPreview.status', input);
}
