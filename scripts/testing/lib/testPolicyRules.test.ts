import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPolicyFindings } from './testPolicyRules.ts';

test('internal-module mock ratchet reports package totals and rejects growth in each file', () => {
  const files = [
    { filePath: 'apps/cli/src/session/one.test.ts', content: "vi.mock('./owner'); vi.mock(import('@/session/other')); vi.mock('node:fs');" },
    { filePath: 'packages/plugins/example/src/two.test.ts', content: "vi.mock('../logic');" },
  ];
  const baseline = { 'apps/cli/src/session/one.test.ts': 1, 'packages/plugins/example/src/two.test.ts': 1 };
  const report = collectPolicyFindings(files, { internalModuleMockBaseline: baseline });
  assert.deepEqual(report.internalModuleMocks, [
    { packagePath: 'apps/cli', count: 2, files: [{ filePath: files[0]!.filePath, count: 2 }] },
    { packagePath: 'packages/plugins/example', count: 1, files: [{ filePath: files[1]!.filePath, count: 1 }] },
  ]);
  assert.deepEqual(report.findings.filter((f) => f.ruleId === 'no-new-internal-module-mocks').map((f) => [f.filePath, f.mode]), [
    [files[0]!.filePath, 'enforce'],
  ]);
  // Removing another file's mocks does not buy permission for a new file.
  const moved = collectPolicyFindings([{ ...files[1]!, filePath: 'packages/plugins/example/src/new.test.ts' }], { internalModuleMockBaseline: baseline });
  assert.equal(moved.findings.filter((f) => f.ruleId === 'no-new-internal-module-mocks').length, 1);
});

test('internal-module mock ratchet permits its baseline and true external boundaries, but counts real syntax', () => {
  const filePath = 'apps/cli/src/session/example.test.ts';
  const content = `
    import { vi as mocker } from 'vitest';
    // vi.mock('./comment');
    const example = "vi.mock('./string')";
    vi.mock('node:child_process'); vi.mock('axios'); vi.mock('react-native');
    // test-policy-boundary: OS process adapter; the real owner runs above this boundary.
    vi.mock('@/platform/processAdapter');
    mocker.mock('./owner');
    vi['mock'](import('../otherOwner'));
    vi.mock('@happier-dev/protocol');
  `;
  const report = collectPolicyFindings([
    { filePath, content },
    { filePath: 'apps/cli/src/session/example.ts', content: "vi.mock('./nonTest');" },
  ], { internalModuleMockBaseline: { [filePath]: 3 } });
  assert.equal(report.internalModuleMocks[0]?.count, 3);
  assert.equal(report.findings.filter((f) => f.ruleId === 'no-new-internal-module-mocks').length, 0);
});

test('internal-module mock ratchet counts application modules even with canonical fixture factories', () => {
  const report = collectPolicyFindings([{
    filePath: 'apps/ui/sources/example.test.tsx',
    content: `
      vi.mock('@/text', async () => { const { createTextModuleMock } = await import('@/dev/testkit/mocks/text'); return createTextModuleMock(); });
      vi.mock('@/modal', async () => { const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal'); return createModalModuleMock().module; });
      vi.mock('@/sync/domains/state/storage', () => ({}));
    `,
  }], { internalModuleMockBaseline: {} });
  assert.equal(report.internalModuleMocks[0]?.count, 3);
  assert.equal(report.findings.filter((f) => f.ruleId === 'no-new-internal-module-mocks').length, 1);
});

test('collectPolicyFindings detects direct policy violations in tests', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/example.test.tsx',
      content: `
        import { testUiMocks } from '@/dev/testkit/testUiMocks';
        const maybeIt = gate ? it : it.skip;
        it.only('focus', () => {});
        console.log('debug');
      `,
    },
  ]);

  const ids = report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`).sort();
  assert.deepEqual(ids, [
    'deprecated-import:test-report-only:report-only',
    'no-console-in-tests:report-only',
    'no-exclusive-tests:enforce',
    'no-hidden-skip-alias:enforce',
  ]);
});

test('collectPolicyFindings keeps hidden skip aliases report-only for provider real probes', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'packages/tests/suites/agents/claude.agentTeams.subagents.jsonl.realProbe.test.ts',
      content: `
        const maybeIt = gate ? it : it.skip;
      `,
    },
  ]);

  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`),
    ['no-hidden-skip-alias:report-only'],
  );
});

test('collectPolicyFindings bans @happier-dev/tests internals from non-test source', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/sync/runtime.ts',
      content: "import { helper } from '@happier-dev/tests/src/testkit/foo';",
    },
  ]);

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, 'no-testkit-imports-in-runtime');
  assert.equal(report.findings[0]?.mode, 'enforce');
});

test('collectPolicyFindings ignores runtime console usage outside tests', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/sync/runtime.ts',
      content: "console.log('allowed outside test policy surface');",
    },
  ]);

  assert.equal(report.findings.length, 0);
});

test('collectPolicyFindings enforces ad hoc UI inline mock families and reports canonical ones', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.test.tsx',
      content: `
        vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined }) }));
        vi.mock('@/modal', async () => {
          const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
          return createModalModuleMock().module;
        });
      `,
    },
  ]);

  const ids = report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`).sort();
  assert.deepEqual(ids, [
    'no-new-internal-module-mocks:enforce',
    'no-ui-ad-hoc-inline-mock-family:enforce',
    'ui-inline-mock-family-report:report-only',
  ]);
});

test('collectPolicyFindings reports UI tree walking when canonical harness imports already exist', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.test.tsx',
      content: `
        import { renderScreen } from '@/dev/testkit';
        const screen = renderScreen(<Example />);
        screen.root.findByProps({ testID: 'save-button' }).props.onPress();
      `,
    },
  ]);

  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`),
    ['no-direct-ui-tree-walk-when-harness-exists:report-only'],
  );
});

test('collectPolicyFindings enforces reactive active-server reads in empty React memos', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.tsx',
      content: `
        import React from 'react';
        import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
        export function Example() {
          return React.useMemo(() => getActiveServerSnapshot().serverUrl, []);
        }
      `,
    },
  ]);

  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`),
    ['no-active-server-snapshot-empty-memo:enforce'],
  );
});

test('collectPolicyFindings enforces reactive active-server reads in React state initializers', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.tsx',
      content: `
        import React from 'react';
        import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
        export function Example() {
          const [snapshot] = React.useState(() => getActiveServerSnapshot());
          return snapshot.serverUrl;
        }
      `,
    },
  ]);

  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`),
    ['no-active-server-snapshot-state-capture:enforce'],
  );
});

test('collectPolicyFindings enforces reactive active-server reads in React refs', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.tsx',
      content: `
        import React, { useRef } from 'react';
        import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
        export function Example() {
          const snapshotRef = useRef(getActiveServerSnapshot());
          return snapshotRef.current.serverUrl;
        }
      `,
    },
  ]);

  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId}:${finding.mode}`),
    ['no-active-server-snapshot-ref-capture:enforce'],
  );
});

test('collectPolicyFindings enforces canonical helpers for detached background spawns in test policy files', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/stack/scripts/testkit/runtime_snapshot_start_testkit.mjs',
      content: `
        import { spawn } from 'node:child_process';
        export function startFixture() {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          return child;
        }
      `,
    },
  ]);

  const finding = report.findings.find((item) => item.ruleId === 'no-raw-detached-background-test-spawn');
  assert.ok(finding);
  assert.equal(finding.mode, 'enforce');
});

test('CommonJS spawn bindings reach detached-process enforcement with and without aliases', () => {
  for (const binding of ['spawn', 'spawn: launch']) {
    const callable = binding === 'spawn' ? 'spawn' : 'launch';
    const report = collectPolicyFindings([{
      filePath: 'scripts/example.test.cjs',
      content: `const { ${binding} } = require('node:child_process'); ${callable}(process.execPath, [], { detached: true });`,
    }]);
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'no-raw-detached-background-test-spawn').length, 1);
  }
});

test('collectPolicyFindings ignores canonical detached test spawn helper modules', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'packages/tests/src/testkit/process/testSpawn.ts',
      content: `
        import { spawn } from 'node:child_process';
        export function spawnDetachedTestProcess(command, args = [], options = {}) {
          const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore',
            ...options,
          });
          child.unref();
          return child;
        }
      `,
    },
  ]);

  const finding = report.findings.find((item) => item.ruleId === 'no-raw-detached-background-test-spawn');
  assert.equal(finding, undefined);
});

test('collectPolicyFindings ignores detached spawn calls inside nested generated fixture template strings', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/stack/scripts/example.integration.test.mjs',
      content: `
        import { spawn } from 'node:child_process';
        const runnerScript = \`
          import { spawn } from 'node:child_process';
          const child = spawn(process.execPath, ['-e', \\\`setInterval(() => {}, 1000)\\\`], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        \`;
      `,
    },
  ]);

  const finding = report.findings.find((item) => item.ruleId === 'no-raw-detached-background-test-spawn');
  assert.equal(finding, undefined);
});

// A raw NUL byte in source makes Git classify the file as binary, after which recursive
// rg/grep skip it in silence -- returning exit 1 rather than any warning. Files in this
// repository became invisible to negative-requirement audits exactly this way.
// The safe spelling of a separator is the escape sequence, never the byte.
test('collectPolicyFindings bans a raw NUL byte in source', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/sync/domains/input/compositeKey.ts',
      // The NUL sits inside a template literal on purpose: that is the shape every real
      // instance has taken, and stripStringsAndComments erases template literals -- so this
      // also pins that the rule reads the raw content and not the stripped code text.
      content: 'export const key = (a: string, b: string): string => `${a}' + String.fromCharCode(0) + '${b}`;',
    },
  ]);

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, 'no-nul-byte-in-source');
  assert.equal(report.findings[0]?.mode, 'enforce');
});

test('collectPolicyFindings accepts the escaped NUL spelling', () => {
  const escapedNulSpelling = '\\u0000';

  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/sync/domains/input/compositeKey.ts',
      content: 'export const key = (a: string, b: string): string => `${a}' + escapedNulSpelling + '${b}`;',
    },
  ]);

  assert.equal(report.findings.length, 0);
});
