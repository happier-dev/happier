import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { StartedDaemon } from '../daemon/daemon';
import { applyTrustedLocalPluginFixture } from '../externalSessionLiveLifecycleFixture';
import { repoRootDir } from '../paths';
import { buildCurrentSourcePublicPluginFixture } from './currentManagedStackPluginUiQa';

/** Shared real public ticket fixture for P04 and the single program journey. */
export async function installExternalTicketAutomationFixture(context: Readonly<{
    testDir: string;
    uiBaseUrl: string;
    daemon: StartedDaemon;
}>, pluginId: string) {
    const pluginRoot = join(context.testDir, pluginId);
    await mkdir(pluginRoot, { recursive: true });
    const sourceRoot = join(repoRootDir(), 'packages/plugin-ui/fixtures/external-authoring/src');
    for (const name of ['ticketAutomationPlugin.ts', 'ticketAutomationSurface.tsx']) {
        await cp(join(sourceRoot, name), join(pluginRoot, name));
    }
    await cp(join(repoRootDir(), 'packages/tests/fixtures/plugin-platform/current-source-native-public/tsconfig.json'),
        join(pluginRoot, 'tsconfig.json'));
    const observationsPath = join(context.testDir, `${pluginId}.observations.jsonl`);
    await writeFile(observationsPath, '');
    const packageJson = JSON.parse(await readFile(join(repoRootDir(),
        'packages/tests/fixtures/plugin-platform/current-source-native-public/package.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ ...packageJson,
        name: `@happier-qa/${pluginId}`, exports: {
            './happier-plugin-ui/tickets': './ticketAutomationSurface.tsx',
        },
    }, null, 2));
    await writeFile(join(pluginRoot, 'index.ts'), [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        "import { appendFileSync } from 'node:fs';",
        "import { createExternalTicketContributions } from './ticketAutomationPlugin.js';",
        `const externalTicketContributions = createExternalTicketContributions(${JSON.stringify(pluginId)});`,
        `const observe = (kind: string) => appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({kind}) + '\\n');`,
        'const plugin = definePlugin({',
        `id: ${JSON.stringify(pluginId)}, version: '0.1.0', entrypoints: { daemon: './dist/index.js' },`,
        '...externalTicketContributions,',
        "actions: { ...externalTicketContributions.actions, 'list-tickets': { ...externalTicketContributions.actions['list-tickets'], run: () => { observe('list'); return externalTicketContributions.actions['list-tickets'].run(); } } },",
        "ui: { views: [{ id: 'tickets', container: 'appPage', target: { kind: 'app' }, renderer: 'tickets', title: 'Tickets' }],",
        "renderers: [{ id: 'tickets', kind: 'reactNative', artifact: 'tickets', requiredHostMethods: ['context', 'executeAction'] }] }",
        '});',
        'export const manifest = plugin.manifest;',
        "export const activate = (...args: Parameters<typeof plugin.activate>) => { observe('activate'); return plugin.activate(...args); };",
    ].join('\n'));
    await buildCurrentSourcePublicPluginFixture(pluginRoot);
    await applyTrustedLocalPluginFixture({ daemonPort: context.daemon.state.httpPort,
        controlToken: context.daemon.state.controlToken, pluginRoot, pluginId,
        interactionId: `p04-${pluginId}` });
    const closeActionId = formatQualifiedPluginActionId({ pluginId, localId: 'close-ticket' });
    return { pluginRoot, pluginId, ticketId: 'ticket-1', subjectKindId: 'ticket',
        eventRef: { pluginId, localId: 'ticket-changed' }, closeActionId,
        pageUrl: `${context.uiBaseUrl}/plugins/${pluginId}/tickets`,
        readObservations: () => readFile(observationsPath, 'utf8'),
    };
}
