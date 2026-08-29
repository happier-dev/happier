/**
 * Lane 09 Iroh conformance inventory.
 *
 * These are release-evidence descriptors, not a transport test double or a new
 * scenario runner.  The real native fixture is owned by Lane 06.  Until its
 * test-only controller is exported, keeping these cases explicitly blocked is
 * safer than claiming coverage from an in-memory byte stream.
 */

export type IrohScenarioId =
  | 'F-IR-01'
  | 'F-IR-02'
  | 'F-IR-03'
  | 'F-IR-04'
  | 'F-IR-05'
  | 'F-IR-06'
  | 'F-IR-07'
  | 'F-IR-08';

export type IrohScenario = Readonly<{
  id: IrohScenarioId;
  name: string;
  status: 'blocked';
  blocker: Readonly<{
    code: 'missing_iroh_test_controller';
    owner: 'Lane 06';
    detail: string;
    wakeCondition: string;
  }>;
}>;

const blocker = {
  code: 'missing_iroh_test_controller' as const,
  owner: 'Lane 06' as const,
  detail: 'Lane 06 has not exported the test-only IrohTestController SPI; no native direct/relay fixture is available.',
  wakeCondition: 'Run against the real Lane 06 fixture after forceDirectOnly/forceRelayOnly/restoreAutomatic/getObservedPath are exported.',
};

export const irohScenarios: readonly IrohScenario[] = [
  { id: 'F-IR-01', name: 'forcedDirect', status: 'blocked', blocker },
  { id: 'F-IR-02', name: 'forcedRelay', status: 'blocked', blocker },
  { id: 'F-IR-03', name: 'standardOnly', status: 'blocked', blocker },
  { id: 'F-IR-04', name: 'networkChange', status: 'blocked', blocker },
  { id: 'F-IR-05', name: 'integrityFailure', status: 'blocked', blocker },
  { id: 'F-IR-06', name: 'streamAndPolling', status: 'blocked', blocker },
  { id: 'F-IR-07', name: 'canonicalOrigin', status: 'blocked', blocker },
  { id: 'F-IR-08', name: 'clientMachineTransfers', status: 'blocked', blocker },
];
