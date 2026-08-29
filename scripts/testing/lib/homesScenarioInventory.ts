/**
 * Lane 09's acceptance catalog. These are deliberately metadata-only records: scenario
 * implementations own their assertions, while this catalog keeps the release gate visible even
 * when a native fixture or an upstream lane is not available yet.
 */
export type HomesScenarioStatus = 'contract-tested' | 'blocked' | 'not-verified';

export type HomesScenarioId =
  | `F-PH-${number} ${string}`
  | `F-MH-${number} ${string}`
  | `F-AD-${number} ${string}`
  | `F-QR-${number} ${string}`
  | `F-IR-${number} ${string}`
  | `F-OP-${number} ${string}`
  | `F-MU-${number} ${string}`;

export interface HomesScenarioInventoryEntry {
  id: HomesScenarioId;
  ownerGlob: string;
  status: HomesScenarioStatus;
  dependency: string;
  reason: string;
}

export const HOME_SCENARIO_OWNER_GLOBS = Object.freeze({
  accountDirectory: 'packages/tests/src/scenarios/accountDirectory*.scenario.ts',
  iroh: 'packages/tests/src/scenarios/iroh*.scenario.ts',
  personalHome: 'packages/tests/src/scenarios/personalHome*.scenario.ts',
  workspaceSync: 'packages/tests/src/scenarios/workspaceSync*.scenario.ts',
  multiHome: 'packages/tests/suites/core-e2e/multiServer.*.slow.e2e.test.ts',
  qr: 'packages/tests/suites/ui-e2e/auth.pairing.addPhone.desktopQrMobileScan.spec.ts',
} as const);

const blocked = (
  id: HomesScenarioId,
  ownerGlob: string,
  dependency: string,
  reason: string,
): HomesScenarioInventoryEntry => ({ id, ownerGlob, status: 'blocked', dependency, reason });

const contractTested = (
  id: HomesScenarioId,
  ownerGlob: string,
  dependency: string,
  reason: string,
): HomesScenarioInventoryEntry => ({ id, ownerGlob, status: 'contract-tested', dependency, reason });

export const HOME_SCENARIO_CATALOG: readonly HomesScenarioInventoryEntry[] = Object.freeze([
  contractTested('F-PH-01 freshDesktopPersonalHome', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L03', 'Runtime spec proves loopback/plaintext policy and stable canonical origin.'),
  contractTested('F-PH-02 bootstrapRecovery', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Backup manifest parser rejects path traversal and preserves required identity fields.'),
  contractTested('F-PH-03 signupClosure', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L03', 'Runtime environment contract renders AUTH_ANONYMOUS_SIGNUP_ENABLED=0.'),
  contractTested('F-PH-04 personalHomeNoIngress', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L03', 'Operation lock provides scoped capability boundary without a Cloud proxy.'),
  contractTested('F-PH-05 daemonSetupNonBlocking', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Explicit erase requires confirmation and is confined to the validated data root.'),

  blocked('F-MH-01 concurrentHomes', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Multi-Home runtime owner is not available.'),
  blocked('F-MH-02 focusDoesNotDisable', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Multi-Home focus owner is not available.'),
  blocked('F-MH-03 oneHomeOffline', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Multi-Home offline/reconnect owner is not available.'),
  blocked('F-MH-04 explicitCreationTarget', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Explicit Home target owner is not available.'),
  blocked('F-MH-05 logoutIsolation', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Per-Home logout owner is not available.'),
  blocked('F-MH-06 pushAttribution', HOME_SCENARIO_OWNER_GLOBS.multiHome, 'L04', 'Home-scoped push attribution owner is not available.'),

  contractTested('F-AD-01 registerDiscoverEnroll', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L01/L02/L04', 'Strict Home descriptors and Account Directory entry schemas are exercised.'),
  contractTested('F-AD-02 directoryIndependentSteadyState', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L02', 'Directory response and preferred Home identity invariants are exercised.'),
  contractTested('F-AD-03 directoryAuthIsolation', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L01/L02', 'Caller-owned /me and strict capability schemas reject injected authority.'),
  contractTested('F-AD-04 assertionFailures', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L01/L02', 'Assertion lifetime/signing-domain bounds are exercised.'),
  contractTested('F-AD-05 directoryMutations', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L02', 'Directory link schema enforces explicit relink and caller ownership.'),
  contractTested('F-AD-06 homeOwnedDeviceApproval', HOME_SCENARIO_OWNER_GLOBS.accountDirectory, 'L02/L05', 'Route/capability family is strict; Home approval remains an upstream runtime gate.'),

  blocked('F-QR-01 directQrNoDirectory', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05', 'QR enrollment owner is not available.'),
  blocked('F-QR-02 typedCredentialMatrix', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05', 'Typed QR credential owner is not available.'),
  blocked('F-QR-03 qrFailures', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05', 'QR failure/retry owner is not available.'),
  blocked('F-QR-04 v1Compatibility', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05', 'QR compatibility owner is not available.'),
  blocked('F-QR-05 reversePhoneApproval', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05/L06', 'Reverse QR approval and Iroh fixture are not available.'),
  blocked('F-QR-06 directQrIrohOnly', HOME_SCENARIO_OWNER_GLOBS.qr, 'L05/L06', 'Direct Iroh QR fixture is not available.'),

  blocked('F-IR-01 forcedDirect', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native Iroh test controller is not available.'),
  blocked('F-IR-02 forcedRelay', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native Iroh relay fixture is not available.'),
  blocked('F-IR-03 standardOnly', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Iroh policy fixture is not available.'),
  blocked('F-IR-04 networkChange', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native network-change fixture is not available.'),
  blocked('F-IR-05 integrityFailure', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native integrity-failure fixture is not available.'),
  blocked('F-IR-06 streamAndPolling', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native stream-limit fixture is not available.'),
  blocked('F-IR-07 canonicalOrigin', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06', 'Native runtime-origin fixture is not available.'),
  blocked('F-IR-08 clientMachineTransfers', HOME_SCENARIO_OWNER_GLOBS.iroh, 'L06/L08', 'Native machine-carrier fixture is not available.'),

  blocked('F-OP-01 uninstallPreservesData', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Personal Home operations owner is not available.'),
  blocked('F-OP-02 backupRestore', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Backup/restore owner is not available.'),
  blocked('F-OP-03 plaintextSearch', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Plaintext search owner is not available.'),
  blocked('F-OP-04 relocation', HOME_SCENARIO_OWNER_GLOBS.personalHome, 'L07', 'Relocation owner is not available.'),

  blocked('F-MU-01 newEngineOneWay', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L08', 'Mutagen replacement owner is not available.'),
  blocked('F-MU-02 crashRecovery', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L08', 'Mutagen crash-recovery owner is not available.'),
  blocked('F-MU-03 conflicts', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L08', 'Mutagen conflict owner is not available.'),
  blocked('F-MU-04 oldEngineRetired', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L08', 'Mutagen old-engine retirement owner is not available.'),
  blocked('F-MU-05 handoffFeatures', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L08', 'Mutagen handoff feature owner is not available.'),
  blocked('F-MU-06 machineCarrier', HOME_SCENARIO_OWNER_GLOBS.workspaceSync, 'L06/L08', 'Native machine-carrier and Mutagen coordinator fixtures are not available.'),
]);

export const HOME_SCENARIO_IDS: readonly HomesScenarioId[] = Object.freeze(
  HOME_SCENARIO_CATALOG.map((scenario) => scenario.id),
);
