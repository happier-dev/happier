import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateReleaseGovernanceClosure,
  type ReleaseGovernanceClosureCheckId,
  type ReleaseGovernanceClosureFile,
} from './releaseGovernanceClosure.ts';

function run(
  files: readonly ReleaseGovernanceClosureFile[],
  enabledChecks: readonly ReleaseGovernanceClosureCheckId[],
) {
  return validateReleaseGovernanceClosure({ files, enabledChecks });
}

test('release governance closure rejects preview-local header/url redactors', () => {
  const result = run(
    [{
      filePath: 'packages/protocol/src/local/services/preview/diagnostics/v1.ts',
      content: [
        'const SAFE_HEADER_NAMES = new Set(["content-type", "sec-websocket-protocol"]);',
        'function sanitizeUrl(rawUrl: string) { return new URL(rawUrl); }',
        'function sanitizeHeaderNames(value: unknown) { return []; }',
      ].join('\n'),
    }],
    ['preview-diagnostics-egress'],
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.map((violation) => violation.message).join('\n'), /RP-ARCH-2/);
});

test('release governance closure requires preview diagnostics to consume the canonical egress owner', () => {
  const result = run(
    [{
      filePath: 'packages/protocol/src/local/services/preview/diagnostics/v1.ts',
      content: [
        'import { redactDiagnosticsHeaders, redactDiagnosticsUrl } from "../../../../browser/diagnostics/egress/headers.js";',
        'export function redactLocalServicePreviewDiagnosticDetails(value: Record<string, unknown>) {',
        '  return { url: redactDiagnosticsUrl(String(value.url ?? "")), headers: redactDiagnosticsHeaders({ "content-type": "x" }) };',
        '}',
      ].join('\n'),
    }],
    ['preview-diagnostics-egress'],
  );

  assert.equal(result.ok, true, result.violations.map((violation) => violation.message).join('\n'));
});

test('release governance closure rejects soft-skip dynamic imports in release-required tests', () => {
  const result = run(
    [{
      filePath: 'packages/protocol/src/local/services/preview/diagnostics/v1.test.ts',
      content: [
        'async function loadModule() {',
        '  return import("./v1.js").catch(() => null);',
        '}',
        'test("vacuous", async () => {',
        '  const mod = await loadModule();',
        '  if (!mod) return;',
        '});',
      ].join('\n'),
    }],
    ['release-test-honesty'],
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.map((violation) => violation.message).join('\n'), /RP-TEST-2/);
});

test('release governance closure rejects soft-skip dynamic imports across all release-critical test roots', () => {
  const releaseCriticalSoftSkipFiles = [
    'apps/cli/src/daemon/browser/sidecar/context/capture.test.ts',
    'apps/cli/src/daemon/browser/actions/runtimeActionExecutor.test.ts',
    'packages/protocol/src/devices/simulator/runtimeV1.test.ts',
    'packages/protocol/src/features/payload/capabilities/browserCapabilities.test.ts',
  ];

  const result = run(
    releaseCriticalSoftSkipFiles.map((filePath) => ({
      filePath,
      content: [
        'async function loadModule() {',
        '  return import("./owner.js").catch(() => null);',
        '}',
        'test("vacuous", async () => {',
        '  const mod = await loadModule();',
        '  if (!mod) return;',
        '});',
      ].join('\n'),
    })),
    ['release-test-honesty'],
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((violation) => violation.filePath).sort(),
    releaseCriticalSoftSkipFiles.sort(),
  );
});

test('release governance closure does not reject non-module catch-null assertions', () => {
  const result = run(
    [{
      filePath: 'apps/cli/src/daemon/browser/recording/sessionMediaWriter.test.ts',
      content: [
        'import { readFile } from "node:fs/promises";',
        'test("persists", async () => {',
        '  const contents = await readFile("/tmp/missing").catch(() => null);',
        '  expect(contents).toBeNull();',
        '});',
      ].join('\n'),
    }],
    ['release-test-honesty'],
  );

  assert.equal(result.ok, true, result.violations.map((violation) => violation.message).join('\n'));
});

test('release governance closure requires surface-context placement to derive from the registry', () => {
  const result = run(
    [{
      filePath: 'packages/protocol/src/plugins/ui/surfaceContext.ts',
      content: [
        'export function resolvePluginUiSurfaceContextPlacement(surfaceId: string) {',
        '  if (surfaceId.startsWith("session.")) return "sessionPane";',
        '  return "unknown";',
        '}',
      ].join('\n'),
    }],
    ['surface-context-placement'],
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.map((violation) => violation.message).join('\n'), /RP-ARCH-3/);
});

test('release governance closure rejects an unconsumed daemon PMS observability socket route', () => {
  const result = run(
    [{
      filePath: 'apps/cli/src/daemon/peer/mediation/observability/routes.ts',
      content: 'export function registerDaemonPeerMediationObservabilityRoutes() {}',
    }],
    ['pms-observability-owner'],
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.map((violation) => violation.message).join('\n'), /RP-PMS-OBS-1/);
});

test('release governance closure rejects built owners that only have test consumers', () => {
  const result = run(
    [
      {
        filePath: 'apps/cli/src/daemon/browser/automation/locators.ts',
        content: 'export function parseLocator() {} export function resolveLocator() {}',
      },
      {
        filePath: 'apps/cli/src/daemon/browser/automation/locators.test.ts',
        content: 'import { parseLocator, resolveLocator } from "./locators";',
      },
    ],
    ['first-audit-reachability'],
  );

  assert.equal(result.ok, false);
  assert.match(result.violations.map((violation) => violation.message).join('\n'), /RP-REACH-1/);
});

test('release governance closure accepts assembled first-audit reachability evidence', () => {
  const result = run(
    [
      {
        filePath: 'apps/cli/src/daemon/browser/context/capture.ts',
        content: 'export interface BrowserContextRoutes { captureSnapshot(): void }',
      },
      {
        filePath: 'apps/cli/src/daemon/browser/automation/adapters/controlBridge.ts',
        content: [
          'import { parseLocator, synthesizeLocatorExpression } from "../locators";',
          'export function createControlAdapterAutomationTransport(input: { browserContext?: { captureSnapshot?: Function } }) {',
          '  parseLocator("role=button");',
          '  synthesizeLocatorExpression(parseLocator("role=button"));',
          '  input.browserContext?.captureSnapshot?.({});',
          '}',
        ].join('\n'),
      },
      {
        filePath: 'apps/cli/src/daemon/browser/automation/locators.ts',
        content: 'export function parseLocator() {} export function resolveLocator() {} export function synthesizeLocatorExpression() {}',
      },
      {
        filePath: 'apps/ui/sources/components/browser/surfaces/browserPresentationRetention.tsx',
        content: 'export function BrowserPresentationRetentionProvider() {} export function BrowserKeepAliveBinder() {}',
      },
      {
        filePath: 'apps/ui/sources/app/(app)/_layout.tsx',
        content: '<BrowserPresentationRetentionProvider />',
      },
      {
        filePath: 'apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx',
        content: [
          'import { BrowserKeepAliveBinder } from "./browserPresentationRetention";',
          'import { readRegisteredBrowserContextAnnotationAdapter } from "@/sync/domains/browser/context/activeViewAttachment";',
          '<BrowserKeepAliveBinder enabled={props.keepAliveAboveRouter === true} />',
          'readRegisteredBrowserContextAnnotationAdapter({ browserSessionId, viewId })?.dispatch(request);',
        ].join('\n'),
      },
      {
        filePath: 'apps/ui/sources/sync/domains/browser/context/annotationAdapter.ts',
        content: 'export function createBrowserContextAnnotationAdapter() {}',
      },
      {
        filePath: 'apps/cli/src/daemon/startDaemon.ts',
        content: 'api.setPeerMediationObservabilityRuntimeActionContextProvider(() => ({ store, accountId, machineId }));',
      },
      {
        filePath: 'apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts',
        content: 'createPeerMediationObservabilityDaemonRuntimeActionExecutor({ store, accountId, machineId });',
      },
      {
        filePath: 'apps/cli/src/daemon/peer/mediation/observability/runtimeActionExecutor.ts',
        content: 'export function createPeerMediationObservabilityDaemonRuntimeActionExecutor() {}',
      },
      {
        filePath: 'apps/cli/src/daemon/browser/automation/adapters/controlBridge.test.ts',
        content: 'it("routes the production snapshot verb through the rich browser-context snapshot producer", () => {}); it("resolves semantic and CSS locators through the production query and wait paths", () => {});',
      },
      {
        filePath: 'apps/ui/sources/components/browser/surfaces/browserPresentationPortal.test.tsx',
        content: 'it("BrowserKeepAliveBinder hosts children in the portal when enabled", () => {});',
      },
      {
        filePath: 'apps/ui/sources/components/browser/BrowserShell.test.tsx',
        content: 'it("uses an injected annotation capture provider to produce the media draft before attaching", () => {});',
      },
      {
        filePath: 'packages/tests/suites/core-e2e/peerMediationObservability.feat.machines.peerMediation.observability.slow.e2e.test.ts',
        content: 'it("subscribes", () => peerMediation.observability.subscribe);',
      },
    ],
    ['first-audit-reachability', 'pms-observability-owner'],
  );

  assert.equal(result.ok, true, result.violations.map((violation) => violation.message).join('\n'));
});
