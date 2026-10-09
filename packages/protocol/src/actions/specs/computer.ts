import {
  ComputerActionResultV1Schema,
  ComputerCaptureResponseV1Schema,
  ComputerControlStatusResponseV1Schema,
  ComputerInputRequestV1Schema,
  ComputerSecretFillRequestV1Schema,
  SecretFillSettlementV1Schema,
  ComputerQueryResponseV1Schema,
  ComputerTargetRequestV1Schema,
  ComputerTargetsListRequestV1Schema,
  ComputerTargetsListResponseV1Schema,
  ComputerMachineRequestV1Schema,
  ComputerTargetSelectRequestV1Schema,
  ComputerSelectedTargetResponseV1Schema,
  ComputerOpenSettingsRequestV1Schema,
  ComputerOpenSettingsResponseV1Schema,
} from '../../computer/v1.js';
import type { RuntimeActionSpecFamily } from './common.js';

export function projectComputerObservationInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { target: _target, sourceId: _sourceId, ...observation } = input as Record<string, unknown>;
  return observation;
}

export const COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS = Object.freeze({
  'computer.targets.list': ComputerTargetsListRequestV1Schema,
  'computer.target.get': ComputerMachineRequestV1Schema,
  'computer.target.select': ComputerTargetSelectRequestV1Schema,
  'computer.permissions.openSettings': ComputerOpenSettingsRequestV1Schema,
  'computer.capture': ComputerTargetRequestV1Schema,
  'computer.query': ComputerTargetRequestV1Schema,
  'computer.input': ComputerInputRequestV1Schema,
  'computer.secret.fill': ComputerSecretFillRequestV1Schema,
  'computer.control.status': ComputerTargetRequestV1Schema,
  'computer.control.interrupt': ComputerTargetRequestV1Schema,
  'computer.control.handBack': ComputerTargetRequestV1Schema,
  'computer.target.close': ComputerTargetRequestV1Schema,
});

export const COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS = Object.freeze({
  'computer.targets.list': ComputerTargetsListResponseV1Schema,
  'computer.target.get': ComputerSelectedTargetResponseV1Schema,
  'computer.target.select': ComputerSelectedTargetResponseV1Schema,
  'computer.permissions.openSettings': ComputerOpenSettingsResponseV1Schema,
  'computer.capture': ComputerCaptureResponseV1Schema,
  'computer.query': ComputerQueryResponseV1Schema,
  'computer.input': ComputerActionResultV1Schema,
  'computer.secret.fill': SecretFillSettlementV1Schema,
  'computer.control.status': ComputerControlStatusResponseV1Schema,
  'computer.control.interrupt': ComputerActionResultV1Schema,
  'computer.control.handBack': ComputerActionResultV1Schema,
  'computer.target.close': ComputerActionResultV1Schema,
});

export const COMPUTER_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: {
    'computer.targets.list': 'List computer targets',
    'computer.target.get': 'Get the Session’s selected computer target',
    'computer.target.select': 'Choose the Session’s computer target',
    'computer.permissions.openSettings': 'Open computer privacy settings',
    'computer.capture': 'Capture computer target',
    'computer.query': 'Read computer accessibility',
    'computer.input': 'Send computer input',
    'computer.secret.fill': 'Request confidential credential entry',
    'computer.control.status': 'Get computer control status',
    'computer.control.interrupt': 'Interrupt computer input',
    'computer.control.handBack': 'Return computer control to the Session',
    'computer.target.close': 'Close computer target control',
  },
  descriptions: {
    'computer.targets.list': 'List native windows and display availability, with owning app names and present-user thumbnails when available. Agent calls require approval by default and never return preview pixels.',
    'computer.target.get': 'Read the Session’s selected target, See/Use access, and host-resolved consent display facts.',
    'computer.target.select': 'Propose a native target or window-title/app hint and See/Use access for the human picker. Approval uses the human’s final selection; waivers use an exact target or a uniquely matching title or app. Replace the Session’s previous target only after draining its input.',
    'computer.permissions.openSettings': 'Ask the selected Mac’s daemon to open Screen Recording or Accessibility privacy settings.',
    'computer.capture': 'Capture the selected native target as a Session image reference with its exact image and native input geometry.',
    'computer.query': 'Read available native accessibility information for the selected target, reporting partial or unavailable information truthfully.',
    'computer.input': 'Send native input against a current capture of a Use-enabled target, returning its accessible target name when known. See-only access refuses input. Delivery alone does not prove the requested effect.',
    'computer.secret.fill': 'Request a human credential choice for the exact observed native field. The request and settlement contain no credential value. Unsupported field or confidential observation verification refuses entry.',
    'computer.control.status': 'Read the host controller, stopping state, and in-flight agent activity with redacted target presentation for the selected native target.',
    'computer.control.interrupt': 'Stop agent input and drain accepted input before returning control to the present user.',
    'computer.control.handBack': 'Return the native target to its owning Session, including after a stop that could not be confirmed; the agent must observe it again before its next input, and canceled input is never replayed.',
    'computer.target.close': 'Stop input and release the owning Session’s native capture and control resources.',
  },
  inputSchemas: COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
