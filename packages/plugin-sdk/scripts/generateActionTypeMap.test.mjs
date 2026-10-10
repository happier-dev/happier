import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import ts from 'typescript';

import {
  createActionTypeMapTimingReporter,
  publishPreparedActionTypeMap,
  runCachedActionTypeMap,
  runActionTypeMapWithWorkspaceLock,
  validateGeneratedModuleSyntax,
  writeFileIfChanged,
} from './generateActionTypeMap.mjs';
import * as actionTypeMapGenerator from './generateActionTypeMap.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

test('an explicit Action map producer invocation defaults to source writes and remote checks', () => {
  // The source checkout owns this generated input, whatever it is publishing: a local
  // artifact publication after a concurrent Protocol edit must regenerate, not fail.
  // Committed staleness is caught by the explicit CI `check:action-type-map` step.
  assert.equal(actionTypeMapGenerator.resolveAutomaticActionTypeMapMode({}), '--write');
  assert.equal(actionTypeMapGenerator.resolveAutomaticActionTypeMapMode({
    HAPPIER_WORKSPACE_BUNDLE_PUBLICATION_MODE: 'artifact',
  }), '--write');
  assert.equal(actionTypeMapGenerator.resolveAutomaticActionTypeMapMode({
    HAPPIER_DEV_TARGET_EXECUTION: '1',
  }), '--check');
});

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GENERATOR_PATH = fileURLToPath(new URL('./generateActionTypeMap.mjs', import.meta.url));
const PACKAGE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const GENERATED_PATH = resolve(PACKAGE_ROOT, 'src/actions/actionTypeMap.generated.ts');

test('generated module validation rejects invalid syntax and private validator references', () => {
  assert.doesNotThrow(() => validateGeneratedModuleSyntax('export type Valid = { value: string };\n'));
  assert.throws(
    () => validateGeneratedModuleSyntax("import type { Private } from '@happier-dev/protocol';\nexport type Invalid = Private;\n"),
    /private or absolute import/u,
  );
  assert.throws(
    () => validateGeneratedModuleSyntax('export type Invalid = z.ZodString;\n'),
    /validator-library implementation reference/u,
  );
  assert.throws(
    () => validateGeneratedModuleSyntax('export type Invalid = {\n'),
    /not valid TypeScript/u,
  );
});

test('Action type map timing identifies declaration projection and publication phases', () => {
  const samples = [100, 125, 190, 260];
  const output = [];
  const phase = createActionTypeMapTimingReporter({
    now: () => samples.shift(),
    write: (line) => output.push(line),
  });

  phase('dto-declaration-projection');
  phase('publication-write');
  phase('publication-check');

  assert.deepEqual(output, [
    'action-type-map: phase=dto-declaration-projection deltaMs=25 totalMs=25\n',
    'action-type-map: phase=publication-write deltaMs=65 totalMs=90\n',
    'action-type-map: phase=publication-check deltaMs=70 totalMs=160\n',
  ]);
});

test('Action type map publication leaves identical output untouched and writes changed output', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');

  await writeFileIfChanged(outputPath, 'first\n');
  const knownOldDate = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(outputPath, knownOldDate, knownOldDate);
  const beforeIdenticalWrite = statSync(outputPath);

  await writeFileIfChanged(outputPath, 'first\n');
  const afterIdenticalWrite = statSync(outputPath);
  assert.equal(afterIdenticalWrite.mtimeMs, beforeIdenticalWrite.mtimeMs);
  if (beforeIdenticalWrite.ino !== 0 && afterIdenticalWrite.ino !== 0) {
    assert.equal(afterIdenticalWrite.ino, beforeIdenticalWrite.ino);
  }

  await writeFileIfChanged(outputPath, 'second\n');
  assert.equal(readFileSync(outputPath, 'utf8'), 'second\n');
  assert.notEqual(statSync(outputPath).mtimeMs, beforeIdenticalWrite.mtimeMs);
});

test('Action map cache skips an unchanged compiler program and re-derives changed, deleted, or corrupt inputs', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const configPath = resolve(directory, 'tsconfig.json');
  const generatorPath = resolve(directory, 'generator.mjs');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const cachePath = resolve(directory, 'action-map-cache.json');
  writeFileSync(sourcePath, 'export type Action = "first";\n');
  writeFileSync(configPath, '{}\n');
  writeFileSync(generatorPath, '// version one\n');
  let programs = 0;
  const derive = async () => {
    programs += 1;
    const program = ts.createProgram([sourcePath], { noEmit: true });
    const source = program.getSourceFile(sourcePath);
    assert.ok(source);
    const output = source.text;
    writeFileSync(outputPath, output);
    return { inputPaths: [sourcePath, configPath, generatorPath], output };
  };
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive });

  await run();
  await run();
  assert.equal(programs, 1, 'unchanged second pass must not construct a Program');

  writeFileSync(sourcePath, 'export type Action = "second";\n');
  await run();
  assert.equal(programs, 2);

  writeFileSync(configPath, '{ "strict": true }\n');
  await run();
  assert.equal(programs, 3);

  writeFileSync(generatorPath, '// version two\n');
  await run();
  assert.equal(programs, 4);

  writeFileSync(outputPath, 'corrupt\n');
  await run();
  assert.equal(programs, 5);

  rmSync(outputPath);
  await run();
  assert.equal(programs, 6);

  rmSync(sourcePath);
  await assert.rejects(run);
  assert.equal(programs, 7, 'missing compiler input must never be admitted as current');
});

test('Action map cache and publication verify every family output, including missing or edited shards', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-shards-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'family.ts');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const familyPath = resolve(directory, 'family.generated.ts');
  const cachePath = resolve(directory, 'cache.json');
  writeFileSync(sourcePath, 'export type Result = { count: number };\n');
  let derivations = 0;
  const derive = () => {
    derivations += 1;
    const output = "export type { Result } from './family.generated.js';\n";
    return { inputPaths: [sourcePath], output,
      outputs: new Map([[outputPath, output], [familyPath, readFileSync(sourcePath, 'utf8')]]) };
  };
  const publish = async ({ outputs }) => {
    for (const [path, output] of outputs) writeFileSync(path, output);
  };
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive, publish });
  await run();
  await run();
  assert.equal(derivations, 1);
  writeFileSync(familyPath, 'export type Result = unknown;\n');
  await run();
  assert.equal(derivations, 2, 'a current index must not conceal an edited family output');
  assert.equal(readFileSync(familyPath, 'utf8'), readFileSync(sourcePath, 'utf8'));
  rmSync(familyPath);
  await run();
  assert.equal(derivations, 3, 'a missing family output must be restored by the same producer');
  writeFileSync(sourcePath, 'export type Result = { count: string };\n');
  await assert.rejects(() => runCachedActionTypeMap({ cachePath, outputPath, derive,
    publish: async (prepared) => {
      await publish(prepared);
      writeFileSync(familyPath, 'corrupt\n');
    },
  }), /publication.*current/u);
  await run();
  assert.equal(readFileSync(familyPath, 'utf8'), readFileSync(sourcePath, 'utf8'));
});

test('the retained Action publisher checks and fences every prepared family output', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-publisher-shards-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const indexPath = resolve(directory, 'index.generated.ts');
  const familyPath = resolve(directory, 'dtos/family.generated.ts');
  const retiredPath = resolve(directory, 'dtos/retired.generated.ts');
  const outputs = new Map([[indexPath, 'export type Index = string;\n'],
    [familyPath, 'export type Result = { count: number };\n']]);
  // The old single-file check sees a current real index, so the only RED is
  // its missing family check. No pre-GREEN test writes the actual SDK map.
  const prepared = { output: readFileSync(GENERATED_PATH, 'utf8'), outputs, obsoleteOutputs: [retiredPath], timing: () => {} };
  const context = { assertOwned: () => {}, assertInputsCurrent: () => {} };
  await assert.rejects(() => publishPreparedActionTypeMap('--check', prepared, context), /stale|ENOENT/u);
  await publishPreparedActionTypeMap('--write', prepared, context);
  for (const [path, expected] of outputs) assert.equal(readFileSync(path, 'utf8'), expected);
  await publishPreparedActionTypeMap('--check', prepared, context);
  writeFileSync(retiredPath, 'retired support copy\n');
  await assert.rejects(() => publishPreparedActionTypeMap('--check', prepared, context), /obsolete/u);
  await publishPreparedActionTypeMap('--write', prepared, context);
  assert.ok(!existsSync(retiredPath));
  writeFileSync(familyPath, 'corrupt\n');
  await assert.rejects(() => publishPreparedActionTypeMap('--check', prepared, context), /stale/u);
  let ownershipChecks = 0;
  await assert.rejects(() => publishPreparedActionTypeMap('--write', prepared, {
    assertOwned: () => { if (++ownershipChecks === 2) throw new Error('lost family lease'); },
    assertInputsCurrent: context.assertInputsCurrent,
  }), /lost family lease/u);
  assert.equal(readFileSync(familyPath, 'utf8'), 'corrupt\n', 'the family is not written after losing its lease');
});

test('Action map remembers a failed derivation for unchanged inputs instead of re-deriving it on every dispatch', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const cachePath = resolve(directory, 'action-map-cache.json');
  writeFileSync(sourcePath, 'export type Action = "first";\n');
  let programs = 0;
  const derive = async () => {
    programs += 1;
    const text = readFileSync(sourcePath, 'utf8');
    if (text.includes('broken')) validateGeneratedModuleSyntax('export type Broken = z.ZodString;');
    return { inputPaths: [sourcePath], output: text };
  };
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive });

  await run();
  assert.equal(programs, 1);

  writeFileSync(sourcePath, 'export type Action = "broken";\n');
  await assert.rejects(run, /validator-library/);
  assert.equal(programs, 2);

  // Same inputs, same deterministic failure: report it without constructing another compiler program.
  await assert.rejects(run, /validator-library/);
  assert.equal(programs, 2, 'an unchanged failing input set must not re-derive');

  // Any input change re-derives.
  writeFileSync(sourcePath, 'export type Action = "fixed";\n');
  await run();
  assert.equal(programs, 3);
  assert.equal(readFileSync(outputPath, 'utf8'), 'export type Action = "fixed";\n');
});

test('Action map retries module-resolution and I/O failures, including new files in existing nested directories', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-failure-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  mkdirSync(resolve(directory, 'existing'));
  let missingPath = resolve(directory, 'missing.ts');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const cachePath = resolve(directory, 'action-map-cache.json');
  writeFileSync(sourcePath, 'export type Action = "first";\n');
  let programs = 0;
  let ioFailure = false;
  const derive = async () => {
    programs += 1;
    if (ioFailure) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    if (readFileSync(sourcePath, 'utf8').includes('import') && !existsSync(missingPath)) {
      const program = ts.createProgram([sourcePath], { noEmit: true });
      const diagnostic = ts.getPreEmitDiagnostics(program).find((entry) => entry.code === 2307);
      assert.ok(diagnostic, 'the compiler must report the unresolved import');
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    }
    return { inputPaths: [sourcePath], output: readFileSync(sourcePath, 'utf8') };
  };
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive });

  await run();
  writeFileSync(sourcePath, 'import type { Missing } from "./missing";\n');
  await assert.rejects(run, /Cannot find module/);

  // The fix is a NEW file that no previously successful input set contained.
  writeFileSync(missingPath, 'export type Missing = string;\n');
  await run();
  assert.equal(programs, 3, 'a new file beside an input must clear the failure memo');

  missingPath = resolve(directory, 'existing/missing.ts');
  writeFileSync(sourcePath, 'import type { Missing } from "./existing/missing";\n');
  await assert.rejects(run, /Cannot find module/);
  writeFileSync(missingPath, 'export type Missing = string;\n');
  await run();
  assert.equal(programs, 5, 'a new nested file must recover without editing any recorded input');

  // A transient I/O failure is not a deterministic result of the inputs.
  writeFileSync(sourcePath, 'export type Action = "io";\n');
  ioFailure = true;
  await assert.rejects(run, /EMFILE/);
  ioFailure = false;
  await run();
  assert.equal(programs, 7, 'an I/O failure must not be memoized');
});

test('Action map never memoizes compiler diagnostics or unavailable-input errors without OS codes', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-diagnostics-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const outputPath = resolve(directory, 'generated.ts');
  const cachePath = resolve(directory, 'cache.json');
  writeFileSync(sourcePath, 'first');
  let failure;
  let programs = 0;
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive: async () => {
    programs += 1;
    if (failure) throw failure;
    return { inputPaths: [sourcePath], output: readFileSync(sourcePath, 'utf8') };
  } });
  await run();
  for (const message of ['Generated Action type map does not compile: invalid dependency.', 'Action type map input is unavailable: config.json']) {
    writeFileSync(sourcePath, message);
    failure = new Error(message);
    await assert.rejects(run, { message });
    failure = undefined;
    await run();
  }
  assert.equal(programs, 5);
});

test('Action map compiler diagnostics can recover through an ambient declaration outside recorded input files', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-ambient-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const typeRoots = resolve(directory, 'types');
  mkdirSync(resolve(typeRoots, 'existing'), { recursive: true });
  writeFileSync(resolve(typeRoots, 'existing/index.d.ts'), 'interface Action { stable: string }');
  writeFileSync(sourcePath, 'export const result = ({} as Action).stable;');
  let programs = 0;
  let failedInputs;
  const run = () => runCachedActionTypeMap({
    cachePath: resolve(directory, 'cache.json'), outputPath: resolve(directory, 'generated.ts'),
    derive: () => {
      programs += 1;
      const program = ts.createProgram([sourcePath], { noEmit: true, typeRoots: [typeRoots] });
      const inputs = program.getSourceFiles().map((file) => [file.fileName, createHash('sha256').update(file.text).digest('hex')]);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length) {
        assert.equal(diagnostics[0].code, 2339, 'this is a property diagnostic, not a module-resolution or I/O error');
        failedInputs = inputs;
        throw Object.assign(new Error(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')), { inputDigests: inputs });
      }
      return { inputPaths: inputs.map(([path]) => path), inputDigests: inputs, output: readFileSync(sourcePath, 'utf8') };
    },
  });
  await run();
  writeFileSync(sourcePath, 'export const result = ({} as Action).added;');
  await assert.rejects(run, /added/);
  mkdirSync(resolve(typeRoots, 'augmentation'));
  writeFileSync(resolve(typeRoots, 'augmentation/index.d.ts'), 'interface Action { added: string }');
  assert.ok(failedInputs.every(([path, expected]) => createHash('sha256').update(readFileSync(path)).digest('hex') === expected));
  await run();
  assert.equal(programs, 3, 'unchanged recorded files do not prove a compiler diagnostic is still current');
});

test('Action map cache and projection-failure hits bypass a busy workspace lock', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-fast-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const outputPath = resolve(directory, 'generated.ts');
  const cachePath = resolve(directory, 'cache.json');
  const lockPath = resolve(directory, 'workspace.lock');
  writeFileSync(sourcePath, 'first');
  const derive = async () => {
    const output = readFileSync(sourcePath, 'utf8');
    if (output === 'broken') validateGeneratedModuleSyntax('export type Broken = z.ZodString;');
    return { inputPaths: [sourcePath], output };
  };
  const run = (withDerivationLock) => runCachedActionTypeMap({ cachePath, outputPath, derive, withDerivationLock });
  let admitted = false;
  await run(async (operation) => {
    admitted = true;
    return await withWorkspaceBundleLock(operation, { lockPath });
  });
  assert.equal(admitted, true, 'a cache miss must derive under the workspace lock');
  for (const state of ['first', 'broken']) {
    if (state === 'broken') {
      writeFileSync(sourcePath, state);
      await assert.rejects(run, /validator-library/);
    }
    let lockEntered = false;
    await withWorkspaceBundleLock(async () => {
      const withDerivationLock = async (operation) => {
        lockEntered = true;
        return await withWorkspaceBundleLock(operation, { lockPath, timeoutMs: 0 });
      };
      if (state === 'first') assert.equal(await run(withDerivationLock), false);
      else await assert.rejects(() => run(withDerivationLock), /validator-library/);
    }, { lockPath });
    assert.equal(lockEntered, false, 'a cache or memo hit must not wait behind a workspace builder');
  }
});

test('Action map projection failure tracks dependencies discovered by the failed derivation', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-new-dependency-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const dependencyPath = resolve(directory, 'new-dependency.ts');
  const outputPath = resolve(directory, 'generated.ts');
  const cachePath = resolve(directory, 'cache.json');
  writeFileSync(sourcePath, 'export type First = string;');
  const run = () => runCachedActionTypeMap({ cachePath, outputPath, derive: () => {
    const paths = existsSync(dependencyPath) ? [sourcePath, dependencyPath] : [sourcePath];
    const sources = paths.map((path) => [path, readFileSync(path, 'utf8')]);
    const output = sources.map(([, text]) => text).join('\n');
    try {
      validateGeneratedModuleSyntax(output);
    } catch (error) {
      error.inputDigests = sources.map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')]);
      throw error;
    }
    return { inputPaths: paths, output };
  } });
  await run();
  writeFileSync(sourcePath, 'export type Second = string;');
  writeFileSync(dependencyPath, 'export type Broken = z.ZodString;');
  await assert.rejects(run, /validator-library/);
  await assert.rejects(run, /validator-library/);
  writeFileSync(dependencyPath, 'export type Fixed = string;');
  await run();
  assert.match(readFileSync(outputPath, 'utf8'), /Fixed/);
});

test('Action map input edited during derivation publishes the snapshot, reports stale, and re-derives next run', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const cachePath = resolve(directory, 'action-map-cache.json');
  writeFileSync(sourcePath, 'export type Action = "first";\n');
  let programs = 0;
  const derive = async ({ editDuringDerivation }) => {
    programs += 1;
    const source = ts.createProgram([sourcePath], { noEmit: true }).getSourceFile(sourcePath);
    assert.ok(source);
    if (editDuringDerivation) writeFileSync(sourcePath, 'export type Action = "second";\n');
    return {
      inputPaths: [sourcePath],
      inputDigests: [[sourcePath, createHash('sha256').update(source.text).digest('hex')]],
      output: source.text,
    };
  };

  writeFileSync(outputPath, 'previous current output');
  await assert.rejects(() => runCachedActionTypeMap({ cachePath, outputPath, derive: () => derive({ editDuringDerivation: true }) }), /inputs changed/i);
  assert.equal(readFileSync(outputPath, 'utf8'), 'export type Action = "first";\n');
  assert.equal(existsSync(cachePath), false);

  // The next run sees no cache and re-derives from the edited input.
  await runCachedActionTypeMap({ cachePath, outputPath, derive: () => derive({ editDuringDerivation: false }) });
  assert.equal(programs, 2);
  assert.equal(readFileSync(outputPath, 'utf8'), 'export type Action = "second";\n');
  assert.equal(existsSync(cachePath), true);
});

test('Action map finishes every snapshot output before reporting inputs stale or changed during publication', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-publication-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'source.ts');
  const outputPath = resolve(directory, 'generated.ts');
  const siblingPath = resolve(directory, 'sibling.ts');
  const cachePath = resolve(directory, 'cache.json');
  for (const mode of ['--write', '--check']) for (const stale of [true, false]) {
    writeFileSync(sourcePath, 'first');
    writeFileSync(outputPath, 'previous');
    await assert.rejects(() => runCachedActionTypeMap({
      cachePath, outputPath, mode,
      derive: () => ({ inputPaths: [sourcePath], inputDigests: [[sourcePath, createHash('sha256').update('first').digest('hex')]],
        output: 'first', outputs: new Map([[outputPath, 'first'], [siblingPath, 'same snapshot']]), stale, timing: () => {} }),
      publish: async (prepared, context) => {
        writeFileSync(sourcePath, 'second');
        await publishPreparedActionTypeMap(mode, prepared, { ...context, assertOwned: () => {} });
      },
    }), /inputs changed/i);
    assert.equal(existsSync(cachePath), false);
    assert.equal(readFileSync(outputPath, 'utf8'), mode === '--write' ? 'first' : 'previous');
    if (mode === '--write') assert.equal(readFileSync(siblingPath, 'utf8'), 'same snapshot');
  }
});

test('Action checks finish without acquiring a busy workspace publication lock', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-check-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'workspace.lock');
  const cancellation = new AbortController();
  await withWorkspaceBundleLock(async () => {
    await assert.doesNotReject(() => runActionTypeMapWithWorkspaceLock({
      mode: '--check', lockPath, env: {},
      // A publication wait is the defect; abort immediately if it happens.
      lockOptions: { signal: cancellation.signal, onWait: () => cancellation.abort() },
      prepare: () => ({ output: 'current' }),
      publish: (_mode, _prepared, { assertOwned }) => { assertOwned(); return 'checked'; },
    }));
  }, { lockPath });
});

for (const mode of ['--write', '--check']) {
  test(`Action map inherited ${mode} completes while an external contender waits for its parent`, async (t) => {
    const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-derive-lock-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const lockPath = resolve(directory, 'cli-dist-build.lock');
    const cancellation = new AbortController();
    const operations = [];
    let external;
    try {
      await withWorkspaceBundleLock(async ({ heldLockValue }) => {
        let externalWaited;
        const waitingForParent = new Promise((resolveWaited) => { externalWaited = resolveWaited; });
        external = runActionTypeMapWithWorkspaceLock({
          mode: '--write', lockPath, env: {},
          lockOptions: { signal: cancellation.signal, onWait: externalWaited },
          prepare: () => ({ output: 'external' }),
          publish: async () => 'external-completed',
        });
        operations.push(external.catch(() => {}));
        await waitingForParent;

        let inheritedWaited;
        const blockedByContender = new Promise((resolveWaited) => {
          inheritedWaited = () => resolveWaited('blocked-by-parent-contender');
        });
        const inherited = runActionTypeMapWithWorkspaceLock({
          mode, lockPath,
          env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
          lockOptions: { signal: cancellation.signal, onWait: inheritedWaited },
          prepare: () => ({ output: 'inherited' }),
          publish: async (_mode, _prepared, { assertOwned }) => {
            assertOwned();
            return 'inherited-completed';
          },
        });
        operations.push(inherited.catch(() => {}));
        // Real filesystem lock notifications distinguish settlement from the
        // parent -> child -> contender -> parent cycle, without a timing budget.
        assert.equal(await Promise.race([inherited, blockedByContender]), 'inherited-completed');
      }, { lockPath });
      assert.equal(await external, 'external-completed');
    } finally {
      cancellation.abort();
      await Promise.all(operations);
    }
  });
}

test('Action type map generation shares the canonical workspace publication lock', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'plugin-sdk.lock');
  let releaseFirst;
  let firstEntered;
  const firstEnteredPromise = new Promise((resolveEntered) => {
    firstEntered = resolveEntered;
  });
  const releaseFirstPromise = new Promise((resolveRelease) => {
    releaseFirst = resolveRelease;
  });
  let secondEntered = false;
  let secondWaited;
  const secondWaitedPromise = new Promise((resolveWaited) => {
    secondWaited = resolveWaited;
  });

  const first = runActionTypeMapWithWorkspaceLock({
    mode: '--write',
    lockPath,
    run: async () => {
      firstEntered();
      await releaseFirstPromise;
    },
  });
  await firstEnteredPromise;

  const second = runActionTypeMapWithWorkspaceLock({
    mode: '--write',
    lockPath,
    lockOptions: { onWait: secondWaited },
    run: async () => {
      secondEntered = true;
    },
  });
  await secondWaitedPromise;
  assert.equal(secondEntered, false);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test('Action type map derives under its own lock while workspace publication is busy', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-prepare-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'plugin-sdk.lock');
  let releaseOwner;
  const owner = runActionTypeMapWithWorkspaceLock({
    mode: '--write',
    lockPath,
    run: async () => await new Promise((resolve) => { releaseOwner = resolve; }),
  });
  while (!releaseOwner) await new Promise((resolve) => setTimeout(resolve, 0));

  let prepared = false;
  let published = false;
  let waited;
  const waiting = new Promise((resolveWaited) => { waited = resolveWaited; });
  const contender = runActionTypeMapWithWorkspaceLock({
    mode: '--write',
    lockPath,
    lockOptions: { onWait: waited },
    prepare: () => {
      assert.equal(existsSync(resolve(directory, 'plugin-sdk-action-type-map.lock')), true);
      prepared = true;
      return { output: 'generated' };
    },
    publish: async () => {
      published = true;
    },
  });

  await waiting;
  const preparedWhileLocked = prepared;
  assert.equal(published, false);
  releaseOwner();
  await Promise.all([owner, contender]);
  assert.equal(preparedWhileLocked, true);
  assert.equal(prepared, true);
  assert.equal(published, true);
});

test('Action type map serializes derivation without taking the publication lock early', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-derivation-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'cli-dist-build.lock');
  let release;
  let entered;
  const enteredPromise = new Promise((done) => { entered = done; });
  const releasePromise = new Promise((done) => { release = done; });
  let secondPrepared = false;
  let waited;
  const waiting = new Promise((done) => { waited = done; });
  const first = runActionTypeMapWithWorkspaceLock({ mode: '--write', lockPath, env: {},
    prepare: async () => { entered(); await releasePromise; return { output: 'first' }; },
    publish: () => {},
  });
  await enteredPromise;
  const second = runActionTypeMapWithWorkspaceLock({ mode: '--write', lockPath, env: {},
    lockOptions: { onWait: waited },
    prepare: () => { secondPrepared = true; return { output: 'second' }; }, publish: () => {},
  });
  await waiting;
  const preparedBeforeRelease = secondPrepared;
  const publicationLockedEarly = existsSync(lockPath);
  release();
  await Promise.all([first, second]);
  assert.equal(preparedBeforeRelease, false);
  assert.equal(publicationLockedEarly, false);
  assert.equal(secondPrepared, true);
});

test('Action map concurrent processes reuse one changed-input derivation and its failure memo', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-single-flight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve(directory, 'action.ts');
  const outputPath = resolve(directory, 'actionTypeMap.generated.ts');
  const cachePath = resolve(directory, 'action-map-cache.json');
  const lockPath = resolve(directory, 'workspace.lock');
  const derivationsPath = resolve(directory, 'derivations');
  writeFileSync(sourcePath, 'first\n');
  await runCachedActionTypeMap({
    cachePath,
    outputPath,
    derive: async () => ({ inputPaths: [sourcePath], output: 'first\n' }),
  });
  const script = `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { runActionTypeMapWithWorkspaceLock, runCachedActionTypeMap, validateGeneratedModuleSyntax } from ${JSON.stringify(new URL('./generateActionTypeMap.mjs', import.meta.url).href)};
    const paths = ${JSON.stringify({ sourcePath, outputPath, cachePath, lockPath, derivationsPath })};
    try {
      const result = await runCachedActionTypeMap({
        withDerivationLock: (operation) => runActionTypeMapWithWorkspaceLock({
          mode: '--write', lockPath: paths.lockPath, env: {},
          run: (_mode, context) => operation(context),
        }),
          cachePath: paths.cachePath, outputPath: paths.outputPath,
          derive: async () => {
            const output = readFileSync(paths.sourcePath, 'utf8');
            appendFileSync(paths.derivationsPath, output);
            await new Promise(resolve => setTimeout(resolve, 150));
            if (output === 'broken\\n') validateGeneratedModuleSyntax('export type Broken = z.ZodString;');
            return { inputPaths: [paths.sourcePath], output };
          },
      });
      console.log(JSON.stringify({ result }));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `;
  const execFileAsync = promisify(execFile);
  const concurrent = async () => {
    const children = await Promise.all(Array.from({ length: 4 }, () => (
      execFileAsync(process.execPath, ['--input-type=module', '--eval', script])
    )));
    return children.map(({ stdout }) => JSON.parse(stdout));
  };

  writeFileSync(sourcePath, 'second\n');
  const successful = await concurrent();
  assert.equal(successful.filter(({ result }) => result === true).length, 1);
  assert.equal(successful.filter(({ result }) => result === false).length, 3);
  assert.equal(readFileSync(derivationsPath, 'utf8'), 'second\n');
  assert.equal(readFileSync(outputPath, 'utf8'), 'second\n');

  writeFileSync(sourcePath, 'broken\n');
  assert.deepEqual(await concurrent(), Array.from({ length: 4 }, () => ({ error: 'Generated Action type map contains a validator-library implementation reference.' })));
  assert.equal(readFileSync(derivationsPath, 'utf8'), 'second\nbroken\n');
  assert.equal(readFileSync(outputPath, 'utf8'), 'second\n');

  writeFileSync(sourcePath, 'fixed\n');
  const recovered = await concurrent();
  assert.equal(recovered.filter(({ result }) => result === true).length, 1);
  assert.equal(readFileSync(derivationsPath, 'utf8'), 'second\nbroken\nfixed\n');
  assert.equal(readFileSync(outputPath, 'utf8'), 'fixed\n');
});

test('Action type map publication receives the canonical lock ownership fence', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-type-map-fence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'plugin-sdk.lock');
  const successorRaw = JSON.stringify({
    pid: 42,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    token: 'successor-owner',
    processInstanceFingerprint: 'successor-incarnation',
  });

  await assert.rejects(
    () => runActionTypeMapWithWorkspaceLock({
      mode: '--write',
      lockPath,
      run: async (_mode, { assertOwned }) => {
        writeFileSync(lockPath, successorRaw, 'utf8');
        assertOwned();
      },
    }),
    /lost workspace bundle lock ownership/i,
  );
  assert.equal(readFileSync(lockPath, 'utf8'), successorRaw);
});

test('Action map preparation inherits the verified lease from its workspace build owner', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'happier-action-map-inherited-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lockPath = resolve(directory, 'workspace.lock');
  const result = await withWorkspaceBundleLock(async ({ heldLockValue }) => (
    runActionTypeMapWithWorkspaceLock({
      mode: '--write',
      lockPath,
      env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
      prepare: () => ({ output: 'prepared under inherited lease' }),
      publish: (_mode, prepared, { inherited, assertOwned }) => {
        assertOwned();
        return { inherited, output: prepared.output };
      },
    })
  ), { lockPath });
  assert.deepEqual(result, { inherited: true, output: 'prepared under inherited lease' });
});

test('generated Action projection is declaration-neutral and retains its public aliases', () => {
  const projection = actionTypeMapGenerator.projectActionDtoDeclarations();
  const source = projection.outputs.get('packages/plugin-sdk/src/actions/actionTypeMap.generated.ts');
  const importPaths = [...source.matchAll(/^import(?: type)? [^;]+ from '([^']+)';$/gmu)]
    .map((match) => match[1]);
  assert.ok(importPaths.length > 0);
  assert.ok(importPaths.every((path) => path.startsWith('./dtos/')));
  for (const output of projection.outputs.values()) validateGeneratedModuleSyntax(output);
  assert.doesNotMatch(
    source,
    /(?:['"]zod(?:\/[^'"]*)?['"]|\bz\.[A-Za-z_$]|\bZod[A-Za-z0-9_]*\b|\$(?:brand|Zod[A-Za-z0-9_]*))/u,
  );
  for (const name of [
    'PluginPolicyExpressionV2',
    'PluginJsonSchemaV2',
    'PluginAgentExternalSessionLinkDataArray',
    'PluginAgentExternalSessionLinkDataObject',
    'PluginAgentExternalSessionLinkDataValue',
    'JSONType',
    'PluginActionWorkflowAuthoredResultReferenceV1',
    'PluginActionWorkflowValueReferenceV1',
    'PluginActionWorkflowConditionV1',
    'PluginActionWorkflowStepV1',
    'PluginActionWorkflowFailurePolicyV1',
    'PluginActionWorkflowItemExecutionModeV1',
    'PluginActionWorkflowEvaluatorHistoryModeV1',
    'PluginActionWorkflowParallelBranchV1',
    'PluginActionWorkflowRepetitionV1',
    'PluginActionWorkflowBlockV1',
    'PluginActionInputById',
    'PluginActionResultById',
    'PluginInvocableActionId',
  ]) {
    assert.match(source, new RegExp(`export type ${name}\\b`, 'u'));
  }
  assert.match(source, /^export type PluginActionWorkflowBlockV1\b/mu);
  assert.doesNotMatch(
    source,
    /(?:^|\W)Workflow(?:AuthoredResultReference|ValueReference|Condition|Step|FailurePolicy|ItemExecutionMode|EvaluatorHistoryMode|ParallelBranch|Repetition|Block)(?:$|\W)/mu,
  );
  assert.doesNotMatch(source, /\bActionSurfaceBinding(?:Caller|Context|Transform)\b/u);
  assert.doesNotMatch(source, /\bActionCaller\b/u);
  assert.doesNotMatch(source, /\bsurfaceBindings\??:/u);
});

test('generated Action DTO signatures use the canonical SDK public declarations', () => {
  const { outputs } = actionTypeMapGenerator.projectActionDtoDeclarations();
  const family = outputs.get('packages/plugin-sdk/src/actions/dtos/automationEventsActionDtos.generated.ts');
  assert.match(family, /import type \{ JsonValue, PluginJsonValueV2 \} from '\.\.\/\.\.\/identity\.js';/u);
  for (const output of outputs.values()) {
    assert.doesNotMatch(output, /export type (?:JsonValue|PluginJsonValueV2)\s*=/u);
  }
  assert.ok(!outputs.has('packages/plugin-sdk/src/actions/dtos/strictJsonValue.generated.ts'));
  assert.ok(!outputs.has('packages/plugin-sdk/src/actions/dtos/jsonSchema.generated.ts'));
  const scmFamily = outputs.get('packages/plugin-sdk/src/actions/dtos/scmDiffSummaryActionDtos.generated.ts');
  assert.match(scmFamily, /import type \{ ScmComparisonSource \} from '\.\.\/\.\.\/scm\/projections\.js';/u);
  for (const output of outputs.values()) {
    assert.doesNotMatch(output, /export type ScmComparisonSource\s*=/u);
  }
});

test('Action DTO projection scopes mapped keys without hiding external declarations', () => {
  const repoRoot = resolve(tmpdir(), 'happier-mapped-dto-fixture');
  const protocolRoot = resolve(repoRoot, 'packages/protocol/src');
  // Substitute only source-file reads; the catalog and declaration parsers stay real.
  const catalogSources = new Map([
    [resolve(protocolRoot, 'actions/actionIds.ts'), "export const ACTION_ID_FAMILIES_V1 = { fixture: ['fixture.read'] };"],
    [resolve(protocolRoot, 'actions/pluginActionSurface.ts'), 'export const PLUGIN_SURFACE_EXCLUSION_REASONS = {};'],
  ]);
  const project = (extra) => actionTypeMapGenerator.projectActionDtoDeclarations({
    repoRoot,
    declarations: new Map([[resolve(protocolRoot, 'actions/pluginActionDtos.ts'),
      'export type PluginActionInputById = { "fixture.read": {} };\n'
        + 'export type PluginActionResultById = { "fixture.read": {} };\n'
        + extra]]),
    readSource: (path) => {
      const source = catalogSources.get(path);
      assert.ok(source !== undefined, `Unexpected source read: ${path}`);
      return source;
    },
  }).outputs.get('packages/plugin-sdk/src/actions/actionTypeMap.generated.ts');

  const mapped = project('export type MappedDto<T> = { [K in keyof T]: T[K] };');
  assert.match(mapped, /export type MappedDto<T> =/u);
  assert.doesNotMatch(mapped, /import type \{[^}]*\bK\b/u);
  validateGeneratedModuleSyntax(mapped);

  const withExternalKey = project(
    'type K = { value: string };\n'
      + 'export type MappedDto<T> = { [K in keyof T]: T[K] } & { external: K };',
  );
  assert.match(withExternalKey, /type K = \{/u);
  assert.match(withExternalKey, /external: K/u);
  validateGeneratedModuleSyntax(withExternalKey);

  const withExternalConstraint = project(
    'type K = { value: string };\n'
      + 'export type MappedDto = { [K in keyof K]: K };',
  );
  assert.match(withExternalConstraint, /type K = \{/u);
  validateGeneratedModuleSyntax(withExternalConstraint);
});

test('generated Plugin Action projection does not publish the host Action census', () => {
  const { outputs } = actionTypeMapGenerator.projectActionDtoDeclarations();
  const output = [...outputs.values()].join('\n');
  // The generated plugin map is an author capability projection, not a census
  // of every host Action. Publishing the canonical ActionId union here bypasses
  // the exact PluginInvocableActionId census and leaks host-only names that are
  // not invocable through PluginApi.actions.
  assert.doesNotMatch(output, /\bHostActionId\b/u);
  for (const internalActionId of [
    'session.handoff.commit',
    'sessions.subagents.upsert',
    'plugin.webhook.delivery.movePending',
  ]) {
    assert.doesNotMatch(
      output,
      new RegExp(`readonly "${internalActionId.replaceAll('.', '\\\\.')}":`, 'u'),
    );
  }
});

test('generated Plugin Action maps include Account requests admitted by the trusted-plugin surface', () => {
  const { inputKeys } = actionTypeMapGenerator.projectActionDtoDeclarations();
  assert.ok(inputKeys.includes('account.security.get'));
  for (const actionId of [
    'account.password.enroll',
    'account.password.change',
    'account.password.remove',
    'account.email.change.request',
    'account.apiTokens.create',
    'account.apiTokens.list',
    'account.apiTokens.revoke',
    'account.apiTokens.revokeAll',
  ]) {
    assert.ok(inputKeys.includes(actionId), `${actionId} is plugin-invocable`);
  }
});
