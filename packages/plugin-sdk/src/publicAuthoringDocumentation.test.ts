import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type ApiSurfaceInventory = Readonly<{
    entrypoints: readonly Readonly<{
        specifier: string;
    }>[];
}>;

type DocumentationEntrypointRow = Readonly<{
    specifier: string;
    purpose: string;
    importExample: string;
}>;

type CapabilityMatrix = Readonly<{
    manifestFamilies: readonly Readonly<{
        manifestFamily: string;
        availabilityDisposition: string;
        provingConsumer: string;
    }>[];
    services: readonly Readonly<{
        serviceId: string;
        availabilityDisposition: string;
        provingConsumer: string;
    }>[];
}>;

const sdkRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(sdkRoot, '../..');
const pluginDocumentationRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins');
const documentationRoot = join(repoRoot, 'apps', 'docs', 'content', 'docs', 'plugins', 'api');
const manifestDocumentationRoot = join(pluginDocumentationRoot, 'manifest');
const entrypointGuidePath = join(documentationRoot, 'sdk-entrypoints.mdx');
const apiNavigationPath = join(documentationRoot, 'meta.json');
const taskGuideNavigationPath = join(pluginDocumentationRoot, 'guides', 'meta.json');
const manifestGuideNavigationPath = join(manifestDocumentationRoot, 'meta.json');
const crossPluginContributionGuidePath = join(
    pluginDocumentationRoot,
    'guides',
    'cross-plugin-contributions.mdx',
);
const accountCollectionsGuidePath = join(
    pluginDocumentationRoot,
    'guides',
    'account-collections.mdx',
);
const webhooksGuidePath = join(
    pluginDocumentationRoot,
    'guides',
    'webhooks.mdx',
);
const pluginTestingGuidePath = join(pluginDocumentationRoot, 'testing', 'index.mdx');
const pluginTestingNavigationPath = join(pluginDocumentationRoot, 'testing', 'meta.json');
const pluginDiagnosticsGuidePath = join(pluginDocumentationRoot, 'testing', 'diagnostics.mdx');
const activationGuidePath = join(documentationRoot, 'activation.mdx');
const actionsGuidePath = join(documentationRoot, 'actions-tools-commands.mdx');
const agentModeGuidePath = join(pluginDocumentationRoot, 'guides', 'agent-modes.mdx');
const agentRuntimeGuidePath = join(pluginDocumentationRoot, 'agent-runtimes', 'agent-runtime.mdx');
const capabilitiesGuidePath = join(manifestDocumentationRoot, 'capabilities-and-permissions.mdx');
const contributionsGuidePath = join(manifestDocumentationRoot, 'contributions.mdx');
const manifestGuidePath = join(manifestDocumentationRoot, 'index.mdx');
const installTrustGuidePath = join(pluginDocumentationRoot, 'packaging', 'install-trust.mdx');
const packagingNavigationPath = join(pluginDocumentationRoot, 'packaging', 'meta.json');
const authoringCliGuidePath = join(pluginDocumentationRoot, 'packaging', 'authoring-cli.mdx');
const versioningGuidePath = join(pluginDocumentationRoot, 'packaging', 'versioning-compat.mdx');
const settingsGuidePath = join(
    repoRoot,
    'apps',
    'docs',
    'content',
    'docs',
    'plugins',
    'services',
    'settings.mdx',
);
const notificationsGuidePath = join(
    repoRoot,
    'apps',
    'docs',
    'content',
    'docs',
    'plugins',
    'services',
    'notifications.mdx',
);

function publicSpecifier(entrypoint: string): string {
    return entrypoint === '.'
        ? '@happier-dev/plugin-sdk'
        : `@happier-dev/plugin-sdk${entrypoint.slice(1)}`;
}

function readEntrypointRows(source: string): readonly DocumentationEntrypointRow[] {
    return source.split(/\r?\n/u).flatMap((line) => {
        const match = /^\| `([^`]+)` \| (.+) \| `(.+)` \|$/u.exec(line);
        if (!match || !match[1].startsWith('@happier-dev/plugin-sdk')) return [];
        return [{
            specifier: match[1],
            purpose: match[2],
            importExample: match[3],
        }];
    });
}

describe('Plugin SDK public authoring documentation', () => {
    it('keeps the exact generated entrypoint inventory discoverable through the docs navigation', () => {
        const inventory = JSON.parse(
            readFileSync(join(sdkRoot, 'api-surface.json'), 'utf8'),
        ) as ApiSurfaceInventory;
        const navigation = JSON.parse(readFileSync(apiNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const guide = readFileSync(entrypointGuidePath, 'utf8');
        const expectedSpecifiers = inventory.entrypoints
            .map(({ specifier }) => publicSpecifier(specifier))
            .sort();
        const rows = readEntrypointRows(guide);

        expect(expectedSpecifiers.length).toBeGreaterThan(0);
        expect(navigation.pages).toContain('sdk-entrypoints');
        expect(rows.map(({ specifier }) => specifier).sort()).toEqual(expectedSpecifiers);

        for (const { specifier, purpose, importExample } of rows) {
            expect(purpose.trim(), specifier).not.toHaveLength(0);
            expect(importExample, specifier).toContain(`from '${specifier}'`);
        }
    });

    it('explains the Preview posture and the distinct resource and host workflows', () => {
        const guide = readFileSync(entrypointGuidePath, 'utf8');
        const sdkReadme = readFileSync(join(sdkRoot, 'README.md'), 'utf8');
        const versioningGuide = readFileSync(versioningGuidePath, 'utf8');

        expect(guide).toContain('one package-level **Developer Preview** source contract');
        expect(guide).toContain('does not create a separate stability tier per export');
        expect(guide).toContain('prepublication hold');
        expect(sdkReadme).toContain('one package-level **Developer Preview** source contract');
        expect(sdkReadme).toContain('remains `private: true` at `0.0.0` and is unpublished');
        expect(sdkReadme).toContain('No public version or released-semver policy');
        expect(sdkReadme).toContain('not a per-symbol stability tier');
        expect(sdkReadme).not.toContain('The approved first public version is `0.1.0`');
        expect(sdkReadme).not.toContain('generated API inventory uses `preview`');
        expect(versioningGuide).toContain('No\npublic version is established by the current source tree');
        expect(versioningGuide).toContain('Source declarations and host wiring establish source readiness, not external\navailability');
        expect(guide).toContain('## One `/resources` path, three resource workflows');
        expect(guide).toContain('`PromptAsset*` and `PromptRegistry*`');
        expect(guide).toContain('`ResourcesService`');
        expect(guide).toContain('`@happier-dev/plugin-sdk/ui`');
        expect(guide).toContain('Host-only: do not import from an installed plugin');
        expect(guide).toContain('Build-realm only');
        expect(guide).toContain('Public browser target and Action descriptors plus the toolchain compatibility packet; browser Actions bind canonical Actions to declared targets.');
        expect(guide).toContain('## What `/testing` proves');
        expect(guide).toContain('selectable `option` targets');
        expect(guide).toContain('not prove installed discovery');
        expect(guide).toMatch(
            /machine routing, native reconciliation, Account encryption, or packaged-artifact\s+behavior/u,
        );
    });

    it('teaches the author route, scoped Settings, Host Actions, and the retained-versus-available HostAccess boundary', () => {
        const navigation = JSON.parse(readFileSync(apiNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const manifestNavigation = JSON.parse(readFileSync(manifestGuideNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const activationGuide = readFileSync(activationGuidePath, 'utf8');
        const actionsGuide = readFileSync(actionsGuidePath, 'utf8');
        const capabilitiesGuide = readFileSync(capabilitiesGuidePath, 'utf8');
        const contributionsGuide = readFileSync(contributionsGuidePath, 'utf8');
        const manifestGuide = readFileSync(manifestGuidePath, 'utf8');
        const settingsGuide = readFileSync(settingsGuidePath, 'utf8');
        const sdkReadme = readFileSync(join(sdkRoot, 'README.md'), 'utf8');

        expect(navigation.pages).toContain('host-actions');
        expect(manifestNavigation.pages).toContain('capabilities-and-permissions');
        expect(activationGuide).toContain('Ordinary root/daemon plugin modules use `definePlugin(...)`');
        expect(activationGuide).toContain('A client-target Action is different');
        expect(activationGuide).toContain('## Low-level daemon ABI conformance');
        expect(activationGuide).toMatch(/not a second\s+normal daemon authoring path/u);
        expect(actionsGuide).toContain('context.services.actions.execute(...)');
        expect(actionsGuide).not.toContain('Commands are available in Developer Preview');
        expect(capabilitiesGuide).toContain('host-owned Agent-session terminal');
        expect(capabilitiesGuide).toMatch(
            /`requestInterceptors` is available to ordinary public authors as a trusted\s+installation-wide declaration/u,
        );
        expect(capabilitiesGuide).not.toContain('External authoring remains deferred until a maintained external development-source');
        expect(capabilitiesGuide).toContain('`network.intercept` is not a public HostAccess capability');
        expect(capabilitiesGuide).toMatch(/no public `hostAccess`\s+request is required/u);
        expect(capabilitiesGuide).toContain('Credential, identity, cookie, token, signature, and API-key headers');
        expect(capabilitiesGuide).toContain('`browser`, `clipboard`, and `externalLinks` as internal declarations');
        expect(capabilitiesGuide).toContain('capability-matrix.json');
        expect(contributionsGuide).toMatch(
            /Descriptor, operation, and embedded-surface roles are public authoring\s+contracts\./u,
        );
        expect(contributionsGuide).toContain('observeForSelf(...)');
        expect(contributionsGuide).not.toContain('not a current external-author product');
        expect(manifestGuide).toContain('retained host-private or deferred declarations');
        expect(manifestGuide).toMatch(/not an\s+author-availability catalog/u);
        expect(settingsGuide).toContain('context.services.settings.forScope({ kind: \'account\' })');
        expect(settingsGuide).not.toContain('settings.watch(listener)');
        expect(sdkReadme).toContain('## Manual ABI (advanced conformance)');
        expect(sdkReadme).toMatch(/It is not the\s+ordinary scaffold path\./u);
        expect(sdkReadme).toMatch(/package is the broad code-defined\s+conformance/u);
        expect(sdkReadme).not.toMatch(/package is the broad manual-ABI\s+conformance/u);
        expect(sdkReadme).toContain('Descriptor, operation, and embedded-surface roles are public authoring contracts.');
        expect(sdkReadme).not.toContain('Actions or renderer chains');
        expect(sdkReadme).toMatch(
            /import\s*\{\s*defineProtocolObject,\s*defineProtocolString,?\s*\}\s*from '@happier-dev\/plugin-sdk\/protocol';/u,
        );
        expect(sdkReadme).not.toMatch(/\bdefineSchema\b/u);
    });

    it('routes cross-plugin authors through feature protocols and immutable operation declarations', () => {
        const navigation = JSON.parse(readFileSync(taskGuideNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;

        expect(navigation.pages).toContain('cross-plugin-contributions');

        const guide = readFileSync(crossPluginContributionGuidePath, 'utf8');
        expect(guide).toContain("from '@happier-dev/channels-protocol/v1'");
        expect(guide).toContain('ConversationProvidersContributionProtocolV1');
        expect(guide).toContain('`.point()`');
        expect(guide).toContain('`.contribute()`');
        expect(guide).toContain('`.declaration`');
        expect(guide).toContain('does not scan Actions');
        expect(guide).toContain('defineContributionProtocol');
        expect(guide).toContain('defineContributionPoint');
        expect(guide).toMatch(
            /Descriptor, operation, and embedded-surface roles are public authoring\s+contracts\./u,
        );
        expect(guide).toContain('observeForSelf(...)');
        expect(guide).toContain('<TargetedSurface');
        expect(guide).toContain('`.node(...)`');
        expect(guide).not.toContain('workItemSourcesV1');
        expect(guide).not.toContain('defineTargetedContributionProtocol');
        expect(guide).not.toContain('defineTargetedContributionPoint');
    });

    it('keeps deferred capability policy separate from actionable collection and webhook tasks', () => {
        const navigation = JSON.parse(readFileSync(taskGuideNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const capabilityMatrix = JSON.parse(
            readFileSync(join(sdkRoot, 'capability-matrix.json'), 'utf8'),
        ) as CapabilityMatrix;
        const accountCollectionsGuide = readFileSync(accountCollectionsGuidePath, 'utf8');
        const webhooksGuide = readFileSync(webhooksGuidePath, 'utf8');
        const installTrustGuide = readFileSync(installTrustGuidePath, 'utf8');
        expect(navigation.pages).toContain('account-collections');
        expect(navigation.pages).toContain('webhooks');
        for (const family of ['commands', 'tools']) {
            expect(capabilityMatrix.manifestFamilies.find((row) => row.manifestFamily === family)).toMatchObject({
                availabilityDisposition: 'deferred',
                provingConsumer: 'no current positive consumer',
            });
        }
        for (const service of ['events', 'fs', 'providers', 'resources']) {
            expect(capabilityMatrix.services.find((row) => row.serviceId === service)).toMatchObject({
                availabilityDisposition: 'deferred',
                provingConsumer: 'no current positive consumer',
            });
        }
        expect(accountCollectionsGuide).toContain('static manifest identity');
        expect(accountCollectionsGuide).toContain('candidate-local');
        expect(accountCollectionsGuide).toContain('one ordered source-to-target chain');
        expect(accountCollectionsGuide).toContain('retry');
        expect(accountCollectionsGuide).toContain('rollback');
        expect(webhooksGuide).toContain('definePluginWebhookTestFixture');
        expect(webhooksGuide).toContain('handlerAction');
        expect(webhooksGuide).toContain('verifier');
        expect(webhooksGuide).toContain('decodePluginWebhookActionRawBody');
        expect(webhooksGuide).toContain('host owns the endpoint, secrets, and queue');
        expect(installTrustGuide).toContain('same daemon lifetime');
        expect(installTrustGuide).toContain('`expired`');
        expect(installTrustGuide).toContain('`outcome_unknown`');
    });

    it('distinguishes external notification source evidence from deferred loaded availability', () => {
        const guide = readFileSync(notificationsGuidePath, 'utf8');
        const apiGuide = readFileSync(join(documentationRoot, 'index.mdx'), 'utf8');
        const entrypointGuide = readFileSync(entrypointGuidePath, 'utf8');

        expect(guide).toContain('capability-matrix.json');
        expect(guide).toContain('notificationChannels');
        expect(guide).toContain('NotificationSender');
        expect(guide).toContain('context.services.notifications.send');
        expect(guide).toContain('context.ui.notify(');
        expect(guide).toContain('examples/action-contract-producer');
        // Markdown line wrapping must not hide the distinguishing phrase.
        expect(guide.replace(/\s+/gu, ' ')).toContain('external-author source-consumer evidence');
        expect(guide).toContain('Loaded availability remains deferred');
        expect(guide).toContain('nonbundled action-contract pair');
        expect(guide).not.toContain('first-party Preview');
        expect(guide).not.toContain('host-internal');
        expect(apiGuide).toContain('- notification channels\n');
        expect(apiGuide).not.toContain('notification channels (deferred; host-internal)');
        expect(entrypointGuide).toContain('Host-mediated notification service, channel sender, and preference result types');
    });

    it('documents the composed targeted proof', () => {
        const testingGuide = readFileSync(pluginTestingGuidePath, 'utf8');

        expect(testingGuide).toContain(
            'hdev plugins test ./target --packed --with-plugin ./contributor',
        );
        expect(testingGuide).toContain('--sdk-registry <origin>');
    });

    it('routes errors through one public diagnostics guide and the cross-bundle PluginError guard', () => {
        const navigation = JSON.parse(readFileSync(pluginTestingNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const diagnosticsGuide = readFileSync(pluginDiagnosticsGuidePath, 'utf8');
        const actionsGuide = readFileSync(actionsGuidePath, 'utf8');

        expect(navigation.pages).toContain('diagnostics');
        expect(diagnosticsGuide).toContain("from '@happier-dev/plugin-sdk'");
        expect(diagnosticsGuide).toContain('isPluginError(error)');
        expect(diagnosticsGuide).toContain('separately bundled SDK copies');
        expect(diagnosticsGuide).toContain('`code`');
        expect(diagnosticsGuide).toContain('`retryable`');
        expect(diagnosticsGuide).toContain('`details`');
        expect(diagnosticsGuide).toContain('`remediation`');
        expect(diagnosticsGuide).toContain('`diagnostics`');
        expect(diagnosticsGuide).toContain('`actionHandlerInvocation`');
        expect(diagnosticsGuide).toContain('host-reported');
        expect(diagnosticsGuide).toContain('advisory');
        expect(diagnosticsGuide).toContain('canonical host-mediated Action');
        expect(diagnosticsGuide).not.toContain('proves the handler was not started');
        expect(actionsGuide).toContain('[Diagnostics](/plugins/testing/diagnostics)');
    });

    it('links Session-Agent authors to the managed source-build advanced package reference', () => {
        const agentModeGuide = readFileSync(agentModeGuidePath, 'utf8');
        const agentRuntimeGuide = readFileSync(agentRuntimeGuidePath, 'utf8');

        for (const guide of [agentModeGuide, agentRuntimeGuide]) {
            expect(guide).toContain('advanced-package-root');
            expect(guide).toContain('hdev plugins dev typecheck .');
            expect(guide).toContain('hdev plugins dev build .');
            expect(guide).toContain('hdev plugins test .');
            expect(guide).not.toContain('hdev plugins test . --packed');
        }
    });

    it('keeps the complete plugin command lifecycle in one authoring CLI reference', () => {
        const navigation = JSON.parse(readFileSync(packagingNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const guide = readFileSync(authoringCliGuidePath, 'utf8');

        expect(navigation.pages).toContain('authoring-cli');
        for (const command of [
            'hdev plugins install',
            'hdev plugins create',
            'hdev plugins dev',
            'hdev plugins test',
            'hdev plugins dev install',
            'hdev plugins dev typecheck',
            'hdev plugins dev build',
            'hdev plugins dev test',
            'hdev plugins pack',
            'hdev plugins doctor',
            'hdev plugins reload',
            'hdev plugins change status',
            'hdev plugins change approve',
            'hdev plugins change reject',
        ]) {
            expect(guide).toContain(command);
        }
        expect(guide).toContain('same pending ID');
        expect(guide).toContain('same daemon lifetime');
        expect(guide).toContain('`--packed`');
        expect(guide).toContain('`--sdk-registry <origin>`');
    });
});
