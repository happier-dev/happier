import { describe, expect, it } from 'vitest';

import {
  MachineSessionTerminalCaptureRequestV1Schema,
  MachineSessionTerminalFinalizeRequestV1Schema,
  MachineSessionTerminalFinalizeResponseV1Schema,
} from './machineSessionTerminalV1.js';
import {
  MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
  MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
} from '../../index.js';

describe('machine session terminal v1', () => {
  it('is exported through the package root used by machine socket peers', () => {
    expect(MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1).toBe('machine-session-terminal-capture-v1');
    expect(MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1).toBe('machine-session-terminal-finalize-v1');
  });

  it('rejects unknown capture request fields', () => {
    expect(MachineSessionTerminalCaptureRequestV1Schema.safeParse({
      v: 1,
      sessionId: 's1',
      machineId: 'payload-authority-is-forbidden',
    }).success).toBe(false);
  });

  it('requires an exact non-negative integer fence', () => {
    expect(MachineSessionTerminalFinalizeRequestV1Schema.safeParse({
      v: 1,
      sessionId: 's1',
      committedFenceMs: 1234,
    }).success).toBe(true);
    expect(MachineSessionTerminalFinalizeRequestV1Schema.safeParse({
      v: 1,
      sessionId: 's1',
      committedFenceMs: 1.25,
    }).success).toBe(false);
  });

  it('keeps terminal responses strict', () => {
    expect(MachineSessionTerminalFinalizeResponseV1Schema.safeParse({
      v: 1,
      status: 'closed',
      sessionId: 's1',
      unexpected: true,
    }).success).toBe(false);
  });
});
