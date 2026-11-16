import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { MachineSetupPreparationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupPreparationV1';
import { composeManagedMachinePresetPreparationBuildInputV1 } from '../machines/managed/presetPreparationBuildInput.js';

const execute = promisify(execFile);

it.skipIf(process.platform === 'win32')('delivers literal preparation stdin and argv through the supplied image CLI and propagates failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-image-preparation-'));
    try {
        const directory = join(home, "cli path's");
        await mkdir(directory);
        // A supplied CLI process is the genuine OS boundary. The fixture exposes
        // its literal argv/stdin and chosen exit status; no domain owner is mocked.
        await writeFile(join(directory, 'happier'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat\nexit "${PREPARATION_TEST_EXIT:-0}"\n', { mode: 0o755 });
        const preparation = MachineSetupPreparationV1Schema.parse({
            basis: { kind: 'preparation', operationId: "build ' $(exit 99)" },
            recipes: [{ recipe: { id: 'literal-input', revision: '1', title: 'Literal input',
                inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
                steps: [{ id: 'install', kind: 'command', executable: 'install-tool', args: [], affects: 'none',
                    check: { executable: 'check-tool', args: [], unsatisfiedExitCodes: [1] } }] },
                selection: { ref: { pluginId: 'test.recipes', recipeId: 'literal-input', revision: '1' },
                    inputs: { value: "quote '\n$(exit 98)" } } }],
        });
        const bakedSetup = { items: [{ kind: 'setupRecipe' as const, selection: preparation.recipes[0]!.selection }] };
        const deferredSetup = { scripts: [{ body: 'deferred-user-context', affects: 'none' as const }] };
        const composed = composeManagedMachinePresetPreparationBuildInputV1({
            operationId: preparation.basis.operationId,
            launch: { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1, choices: {} },
            cli: { identity: 'actual-test-payload', versionId: '0.3.0', binaryPath: "$HOME/cli path's/happier", installScript: '', files: [] },
            setup: { preparation, bakedSetup, deferredSetup },
        });
        expect(composed.bakedSetup).toBe(bakedSetup);
        expect(composed.deferredSetup).toBe(deferredSetup);
        expect(composed.input).not.toHaveProperty('setupPreparation');
        expect(JSON.stringify(composed.input)).not.toContain('deferred-user-context');
        const command = composed.input.setupScript!;
        expect(typeof command).toBe('string');
        const { stdout } = await execute('sh', ['-c', command], { env: { ...process.env, HOME: home, PREPARATION_TEST_EXIT: '0' } });
        const [machine, effect, operation, frame] = stdout.trimEnd().split('\n');
        expect([machine, effect, operation]).toEqual(['machine', 'effect-internal', `--operation-id=${preparation.basis.operationId}`]);
        expect(JSON.parse(frame!)).toEqual({ v: 1, mode: 'apply', preparation });
        await expect(execute('sh', ['-c', command], { env: { ...process.env, HOME: home, PREPARATION_TEST_EXIT: '23' } }))
            .rejects.toMatchObject({ code: 23 });
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
