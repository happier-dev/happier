/**
 * The public-surface half of `qa/QA-PROTOCOL.md` QB-01 and QB-08.
 *
 * QB-01 asks whether an outside author can build a Triage source against the
 * published package alone. That is only true if this fixture's shipped bytes
 * import nothing else, so the import boundary is asserted over the real files
 * rather than trusted.
 *
 * QB-08 asks whether one canonical owner holds the source catalog. §1 requires
 * that census to inspect ownership rather than match a symbol name, so it walks
 * explicit source roots and reports which packages *declare* the target point
 * and which *publish* the protocol.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(fixtureRoot, '../../../../..');

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'build', 'coverage']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js'];

async function collectSourceFiles(root) {
    const found = [];
    async function walk(directory) {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
                continue;
            }
            if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
                found.push(absolute);
            }
        }
    }
    await walk(root);
    return found;
}

async function readJson(relativePath) {
    return JSON.parse(await readFile(join(fixtureRoot, relativePath), 'utf8'));
}

test('QB-01: the committed manifest is the current public source projection', async () => {
    const { manifest } = await import('../src/index.mjs');
    const committed = await readJson('.happier-plugin/plugin.json');

    assert.deepEqual(committed, JSON.parse(JSON.stringify(manifest)));
    assert.equal(committed.id, 'acme.ledger');
    assert.deepEqual(committed.contributes.targetedPluginContributions.map((c) => c.target), [{
        pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    }]);
});

test('QB-01: every shipped fixture module imports only published entry points', async () => {
    const sources = await collectSourceFiles(join(fixtureRoot, 'src'));
    assert.ok(sources.length >= 3);

    const allowedPackages = new Set([
        '@happier-dev/plugin-sdk',
        '@happier-dev/triage-protocol/v1',
    ]);
    const imported = [];

    for (const absolute of sources) {
        const text = await readFile(absolute, 'utf8');
        const specifiers = [...text.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);
        imported.push(...specifiers);
        for (const specifier of specifiers) {
            if (specifier.startsWith('./')) continue;
            assert.equal(
                allowedPackages.has(specifier),
                true,
                `${relative(repoRoot, absolute)} imports non-public ${specifier}`,
            );
        }
        assert.equal(/from\s+'node:/u.test(text), false, `${absolute} reaches for a Node built-in`);
        assert.equal(/@happier-dev\/protocol(?:\/|')/u.test(text), false);
        assert.equal(/@happier-dev\/triage-protocol\/(?:src|dist)/u.test(text), false);
        assert.equal(/\.\.\/\.\.\//u.test(text), false, `${absolute} escapes the fixture package`);
    }

    // The fixture genuinely consumes both published surfaces, so the allowlist
    // above is a real boundary rather than a vacuous one.
    assert.deepEqual(
        [...allowedPackages].filter((name) => imported.includes(name)),
        ['@happier-dev/plugin-sdk', '@happier-dev/triage-protocol/v1'],
    );
});

test('QB-01: the fixture is packaged as an external author would package it', async () => {
    const packageJson = await readJson('package.json');

    assert.equal(packageJson.private, true);
    assert.equal(packageJson.main, './src/index.mjs');
    assert.deepEqual(packageJson.exports, { '.': './src/index.mjs' });
    assert.equal(packageJson.dependencies['@happier-dev/plugin-sdk'], '>=0.0.0 <1.0.0');
    assert.equal(packageJson.dependencies['@happier-dev/triage-protocol'], '>=0.0.0 <1.0.0');
    assert.equal(packageJson.dependencies['@happier-dev/protocol'], undefined);
    assert.equal(
        Object.values(packageJson.dependencies).some((range) => range.startsWith('workspace:')),
        false,
    );
    assert.deepEqual(packageJson.files, ['.happier-plugin/plugin.json', 'src']);
});

test('QB-08: exactly one plugin package declares the Triage sources contribution point', async () => {
    const pluginPackages = await readdir(join(repoRoot, 'packages', 'plugins'), {
        withFileTypes: true,
    });
    const declaringPackages = [];

    for (const entry of pluginPackages) {
        if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const sources = await collectSourceFiles(join(repoRoot, 'packages', 'plugins', entry.name, 'src'));
        for (const absolute of sources) {
            if (absolute.endsWith('.test.ts') || absolute.endsWith('.test.mjs')) continue;
            const text = await readFile(absolute, 'utf8');
            // Ownership, not symbol presence: a declarer passes the point value
            // into its own `contributionPoints` declaration.
            if (/contributionPoints\s*:/u.test(text)
                && text.includes('TriageSourcesContributionPointV1')) {
                declaringPackages.push(entry.name);
                break;
            }
        }
    }

    assert.deepEqual(declaringPackages, ['triage']);
});

test('QB-08: exactly one package publishes the source protocol and its conformance checker', async () => {
    const packageRoots = await readdir(join(repoRoot, 'packages'), { withFileTypes: true });
    const protocolDeclarers = [];
    const checkerDeclarers = [];

    for (const entry of packageRoots) {
        if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const sources = await collectSourceFiles(join(repoRoot, 'packages', entry.name, 'src'));
        for (const absolute of sources) {
            const text = await readFile(absolute, 'utf8');
            if (text.includes('defineContributionProtocol(')
                && (text.includes(TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1)
                    || text.includes('TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1'))) {
                protocolDeclarers.push(relative(repoRoot, absolute));
            }
            if (/export function checkTriageSourceContributionV1/u.test(text)) {
                checkerDeclarers.push(relative(repoRoot, absolute));
            }
        }
    }

    assert.deepEqual(protocolDeclarers, ['packages/triage-protocol/src/v1/contribution.ts']);
    assert.deepEqual(checkerDeclarers, ['packages/triage-protocol/src/testing/v1/conformance.ts']);
});
