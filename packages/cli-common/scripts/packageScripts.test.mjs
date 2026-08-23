import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

/**
 * Scripts that enter this package's build/publication lifecycle.
 *
 * `build` re-enters the CLI dist snapshot lock and the shared-dependency mutation lock, so a test
 * lane that invokes it can deadlock or race a concurrent publication. The test lane must consume
 * whatever `dist` the install/build already produced instead of producing one.
 */
const PUBLICATION_LIFECYCLE_SCRIPTS = ['build', 'build:clean', 'clean', 'prepack', 'prepublishOnly', 'postinstall', 'postinstall:real'];

/**
 * Bodies of every script the named entrypoint actually runs, following `yarn <script>` /
 * `$npm_execpath run <script>` delegation inside this manifest.
 *
 * Asserting one exact command string instead would fail for any edit at all — including a safe
 * one — while still passing a rename of `build` into a chained helper. Resolving the chain checks
 * the property the contract is about.
 */
function collectChainedScriptBodies(scripts, entryScriptName) {
    const bodies = [];
    const seen = new Set();
    const queue = [entryScriptName];

    while (queue.length > 0) {
        const scriptName = queue.shift();
        if (seen.has(scriptName)) continue;
        seen.add(scriptName);

        const body = scripts[scriptName];
        if (typeof body !== 'string' || body.trim() === '') continue;
        bodies.push({ scriptName, body });

        for (const match of body.matchAll(/(?:\byarn\b(?:\s+-s)?|\$npm_execpath\s+run|\bnpm\s+run)\s+([A-Za-z0-9:._-]+)/g)) {
            const ref = match[1];
            if (typeof scripts[ref] === 'string') queue.push(ref);
        }
    }

    return bodies;
}

test('cli-common source tests do not enter the package publication lifecycle', () => {
    const chained = collectChainedScriptBodies(packageJson.scripts, 'test:local');

    expect(chained.map(({ scriptName }) => scriptName)).toContain('test:local');

    for (const { scriptName, body } of chained) {
        for (const lifecycleScript of PUBLICATION_LIFECYCLE_SCRIPTS) {
            const invocation = new RegExp(
                `(?:\\byarn\\b(?:\\s+-s)?|\\$npm_execpath\\s+run|\\bnpm\\s+run)\\s+${lifecycleScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9:._-])`,
            );
            expect(
                body,
                `${scriptName} must not invoke the ${lifecycleScript} script`,
            ).not.toMatch(invocation);
        }
    }
});
