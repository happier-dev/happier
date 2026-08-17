import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type ApiSurfaceInventory = Readonly<{
    entrypoints: readonly Readonly<{
        specifier: string;
    }>[];
}>;

type CapabilityMatrix = Readonly<{
    manifestFamilies: readonly Readonly<{
        manifestFamily: string;
        availabilityDisposition: 'available' | 'deferred' | 'retired';
    }>[];
}>;

type DocumentationEntrypointRow = Readonly<{
    specifier: string;
    purpose: string;
    importExample: string;
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
const activationGuidePath = join(documentationRoot, 'activation.mdx');
const actionsGuidePath = join(documentationRoot, 'actions-tools-commands.mdx');
const capabilitiesGuidePath = join(manifestDocumentationRoot, 'capabilities-and-permissions.mdx');
const contributionsGuidePath = join(manifestDocumentationRoot, 'contributions.mdx');
const manifestGuidePath = join(manifestDocumentationRoot, 'index.mdx');
const installTrustGuidePath = join(pluginDocumentationRoot, 'packaging', 'install-trust.mdx');
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

        expect(expectedSpecifiers).toHaveLength(48);
        expect(navigation.pages).toContain('sdk-entrypoints');
        expect(rows.map(({ specifier }) => specifier).sort()).toEqual(expectedSpecifiers);

        for (const { specifier, purpose, importExample } of rows) {
            expect(purpose.trim(), specifier).not.toHaveLength(0);
            expect(importExample, specifier).toContain(`from '${specifier}'`);
        }
    });

    it('explains the Preview posture and the distinct resource and host workflows', () => {
        const guide = readFileSync(entrypointGuidePath, 'utf8');

        expect(guide).toContain('**Developer Preview** source contracts');
        expect(guide).toContain('prepublication hold');
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

    it('teaches the author route, scoped Settings, and the retained-versus-available HostAccess boundary', () => {
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

        expect(navigation.pages).not.toContain('host-actions');
        expect(manifestNavigation.pages).toContain('capabilities-and-permissions');
        expect(activationGuide).toContain('Ordinary plugin modules use `definePlugin(...)`');
        expect(activationGuide).toContain('## Low-level ABI conformance');
        expect(activationGuide).toContain('not a second normal authoring path');
        expect(actionsGuide).toContain('context.services.actions.execute(...)');
        expect(capabilitiesGuide).toContain('host-owned Agent-session terminal');
        expect(capabilitiesGuide).toContain('`requestInterceptors` is a trusted installation-wide declaration');
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

    it('projects the capability matrix into author guidance and keeps available collection and webhook tasks actionable', () => {
        const navigation = JSON.parse(readFileSync(taskGuideNavigationPath, 'utf8')) as Readonly<{
            pages: readonly string[];
        }>;
        const contributionsGuide = readFileSync(contributionsGuidePath, 'utf8');
        const publicAuthoringReadme = readFileSync(
            join(sdkRoot, 'examples', 'public-authoring', 'README.md'),
            'utf8',
        );
        const publicAuthoringDefinition = readFileSync(
            join(sdkRoot, 'examples', 'public-authoring', 'definition.ts'),
            'utf8',
        );
        const accountCollectionsGuide = readFileSync(accountCollectionsGuidePath, 'utf8');
        const webhooksGuide = readFileSync(webhooksGuidePath, 'utf8');
        const installTrustGuide = readFileSync(installTrustGuidePath, 'utf8');
        const capabilityMatrix = JSON.parse(readFileSync(
            join(sdkRoot, 'capability-matrix.json'),
            'utf8',
        )) as CapabilityMatrix;
        const availabilityByFamily = new Map(capabilityMatrix.manifestFamilies.map((family) => [
            family.manifestFamily,
            family.availabilityDisposition,
        ]));

        expect(navigation.pages).toContain('account-collections');
        expect(navigation.pages).toContain('webhooks');
        expect(availabilityByFamily.get('accountCollections')).toBe('available');
        expect(availabilityByFamily.get('webhooks')).toBe('available');
        expect(availabilityByFamily.get('tools')).toBe('deferred');
        expect(availabilityByFamily.get('commands')).toBe('deferred');
        expect(availabilityByFamily.get('sessionHeaderActions')).toBe('deferred');
        expect(availabilityByFamily.get('openableContentViewers')).toBe('deferred');
        expect(availabilityByFamily.get('mcp.servers')).toBe('deferred');
        expect(availabilityByFamily.get('composerReferences')).toBe('deferred');
        expect(availabilityByFamily.get('composerAttachments')).toBe('deferred');
        expect(availabilityByFamily.get('composerControls')).toBe('deferred');
        expect(availabilityByFamily.get('composerRegions')).toBe('deferred');
        expect(contributionsGuide).toContain('capability-matrix.json');
        expect(contributionsGuide).toContain('Deferred — conformance only');
        expect(contributionsGuide).toContain('`tools`, `commands`,\n`sessionHeaderActions`, `openableContentViewers`, and `mcp.servers`');
        expect(contributionsGuide).toContain('`composer.references`,\n`composer.attachments`, `composer.controls`, and `composer.regions`');
        expect(contributionsGuide).toContain('mcp.servers');
        expect(publicAuthoringReadme).toContain('capability-matrix.json');
        expect(publicAuthoringReadme).toContain('conformance-only');
        expect(publicAuthoringDefinition).toContain('Deferred — conformance-only surface');
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

    it('documents the composed targeted proof', () => {
        const testingGuide = readFileSync(pluginTestingGuidePath, 'utf8');

        expect(testingGuide).toContain(
            'happier plugins test ./target --packed --with-plugin ./contributor',
        );
        expect(testingGuide).toContain('--sdk-registry <origin>');
    });
});
