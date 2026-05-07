import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPolicyFindings } from './testPolicyRules.ts';

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
      filePath: 'packages/tests/suites/providers/claude.agentTeams.subagents.jsonl.realProbe.test.ts',
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

test('collectPolicyFindings enforces reactive active-server reads in empty React memos for namespace imports', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.tsx',
      content: `
        import React from 'react';
        import * as serverRuntime from '@/sync/domains/server/serverRuntime';
        export function Example() {
          return React.useMemo(() => serverRuntime.getActiveServerSnapshot().serverUrl, []);
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

test('collectPolicyFindings enforces reactive active-server reads in React state initializers for aliased imports', () => {
  const report = collectPolicyFindings([
    {
      filePath: 'apps/ui/sources/components/example.tsx',
      content: `
        import React from 'react';
        import { getActiveServerSnapshot as readActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
        export function Example() {
          const [snapshot] = React.useState(() => readActiveServerSnapshot());
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
