import {
  ComputerActionResultV1Schema,
  ComputerCaptureResponseV1Schema,
  ComputerControlStatusResponseV1Schema,
  ComputerInputRequestV1Schema,
  ComputerClipboardWriteRequestV1Schema,
  ComputerClipboardResultV1Schema,
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
  resolveComputerAccess,
} from '../../computer/v1.js';
import type { RuntimeActionSpecFamily } from './common.js';
import type { ApprovalNarrowing } from '../../approvals/approvalNarrowing.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

export const computerTargetSelectionNarrowing: ApprovalNarrowing = {
  narrow(original, chosen) {
    const source = ComputerTargetSelectRequestV1Schema.safeParse(original);
    const selection = ComputerTargetSelectRequestV1Schema.safeParse(chosen);
    if (!source.success || !selection.success || !selection.data.target) return null;
    const { target: _sourceTarget, access: sourceAccess, ...sourceSubject } = source.data;
    const { target: _chosenTarget, access: chosenAccess, ...chosenSubject } = selection.data;
    if (!sameStrictJsonValue(sourceSubject, chosenSubject)
      || (sourceAccess === 'see' && resolveComputerAccess(chosenAccess) !== 'see')) return null;
    return selection.data;
  },
};

export function projectComputerObservationInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { target: _target, sourceId: _sourceId, ...observation } = input as Record<string, unknown>;
  return observation;
}

type ComputerRuntimeActionInputSchemas = Readonly<{
  'computer.targets.list': typeof ComputerTargetsListRequestV1Schema;
  'computer.target.get': typeof ComputerMachineRequestV1Schema;
  'computer.target.select': typeof ComputerTargetSelectRequestV1Schema;
  'computer.permissions.openSettings': typeof ComputerOpenSettingsRequestV1Schema;
  'computer.capture': typeof ComputerTargetRequestV1Schema;
  'computer.query': typeof ComputerTargetRequestV1Schema;
  'computer.input': typeof ComputerInputRequestV1Schema;
  'computer.clipboard.read': typeof ComputerTargetRequestV1Schema;
  'computer.clipboard.write': typeof ComputerClipboardWriteRequestV1Schema;
  'computer.secret.fill': typeof ComputerSecretFillRequestV1Schema;
  'computer.control.status': typeof ComputerTargetRequestV1Schema;
  'computer.control.interrupt': typeof ComputerTargetRequestV1Schema;
  'computer.control.handBack': typeof ComputerTargetRequestV1Schema;
  'computer.target.close': typeof ComputerTargetRequestV1Schema;
}>;
type ComputerRuntimeActionOutputSchemas = Readonly<{
  'computer.targets.list': typeof ComputerTargetsListResponseV1Schema;
  'computer.target.get': typeof ComputerSelectedTargetResponseV1Schema;
  'computer.target.select': typeof ComputerSelectedTargetResponseV1Schema;
  'computer.permissions.openSettings': typeof ComputerOpenSettingsResponseV1Schema;
  'computer.capture': typeof ComputerCaptureResponseV1Schema;
  'computer.query': typeof ComputerQueryResponseV1Schema;
  'computer.input': typeof ComputerActionResultV1Schema;
  'computer.clipboard.read': typeof ComputerClipboardResultV1Schema;
  'computer.clipboard.write': typeof ComputerClipboardResultV1Schema;
  'computer.secret.fill': typeof SecretFillSettlementV1Schema;
  'computer.control.status': typeof ComputerControlStatusResponseV1Schema;
  'computer.control.interrupt': typeof ComputerActionResultV1Schema;
  'computer.control.handBack': typeof ComputerActionResultV1Schema;
  'computer.target.close': typeof ComputerActionResultV1Schema;
}>;

export const COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS: ComputerRuntimeActionInputSchemas = Object.freeze({
  'computer.targets.list': ComputerTargetsListRequestV1Schema,
  'computer.target.get': ComputerMachineRequestV1Schema,
  'computer.target.select': ComputerTargetSelectRequestV1Schema,
  'computer.permissions.openSettings': ComputerOpenSettingsRequestV1Schema,
  'computer.capture': ComputerTargetRequestV1Schema,
  'computer.query': ComputerTargetRequestV1Schema,
  'computer.input': ComputerInputRequestV1Schema,
  'computer.clipboard.read': ComputerTargetRequestV1Schema,
  'computer.clipboard.write': ComputerClipboardWriteRequestV1Schema,
  'computer.secret.fill': ComputerSecretFillRequestV1Schema,
  'computer.control.status': ComputerTargetRequestV1Schema,
  'computer.control.interrupt': ComputerTargetRequestV1Schema,
  'computer.control.handBack': ComputerTargetRequestV1Schema,
  'computer.target.close': ComputerTargetRequestV1Schema,
});

export const COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS: ComputerRuntimeActionOutputSchemas = Object.freeze({
  'computer.targets.list': ComputerTargetsListResponseV1Schema,
  'computer.target.get': ComputerSelectedTargetResponseV1Schema,
  'computer.target.select': ComputerSelectedTargetResponseV1Schema,
  'computer.permissions.openSettings': ComputerOpenSettingsResponseV1Schema,
  'computer.capture': ComputerCaptureResponseV1Schema,
  'computer.query': ComputerQueryResponseV1Schema,
  'computer.input': ComputerActionResultV1Schema,
  'computer.clipboard.read': ComputerClipboardResultV1Schema,
  'computer.clipboard.write': ComputerClipboardResultV1Schema,
  'computer.secret.fill': SecretFillSettlementV1Schema,
  'computer.control.status': ComputerControlStatusResponseV1Schema,
  'computer.control.interrupt': ComputerActionResultV1Schema,
  'computer.control.handBack': ComputerActionResultV1Schema,
  'computer.target.close': ComputerActionResultV1Schema,
});

export const COMPUTER_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  approvalPolicies: {
    'computer.target.close': { agentDefault: 'authority', requiredSurfaces: ['agent', 'mcp', 'plugin', 'api'] },
    'computer.targets.list': { agentDefault: 'egress' },
    'computer.capture': { agentDefault: 'egress', computerConsent: true },
    'computer.query': { agentDefault: 'egress', computerConsent: true },
    'computer.input': { computerConsent: true },
    'computer.permissions.openSettings': { agentDefault: 'authority' },
    'computer.target.select': { agentDefault: 'authority' },
    'computer.control.interrupt': { agentDefault: 'authority' },
    'computer.control.handBack': { agentDefault: 'authority' },
  },
  titles: {
    'computer.targets.list': 'List computer targets',
    'computer.target.get': 'Get the Session’s selected computer target',
    'computer.target.select': 'Choose the Session’s computer target',
    'computer.permissions.openSettings': 'Open computer privacy settings',
    'computer.capture': 'Capture computer target',
    'computer.query': 'Read computer accessibility',
    'computer.input': 'Send computer input',
    'computer.clipboard.read': 'Copy from the computer clipboard',
    'computer.clipboard.write': 'Paste to the computer clipboard',
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
    'computer.query': 'Read available native accessibility information for the selected target, reporting partial or unavailable information truthfully. The producing provider and captureId bind returned element IDs to subsequent computer.input operations.',
    'computer.input': 'Send click, key, text, drag, wheel, or element click/set_value input against a current capture of a Use-enabled target. An optional provider selects an enabled installed provider; element IDs remain bound to their producing provider and observation. See-only access refuses input. Delivery alone does not prove the requested effect.',
    'computer.clipboard.read': 'Read text from the selected computer desktop clipboard for the present user. Clipboard content stays private to the live invocation.',
    'computer.clipboard.write': 'Write text to the selected computer desktop clipboard for the present user. Clipboard content stays private to the live invocation.',
    'computer.secret.fill': 'Request a human credential choice for the exact observed native field. The request and settlement contain no credential value. Unsupported field or confidential observation verification refuses entry.',
    'computer.control.status': 'Read the host controller, stopping state, and in-flight agent activity with redacted target presentation for the selected native target.',
    'computer.control.interrupt': 'Stop agent input and drain accepted input before returning control to the present user.',
    'computer.control.handBack': 'Return the native target to its owning Session, including after a stop that could not be confirmed; the agent must observe it again before its next input, and canceled input is never replayed.',
    'computer.target.close': 'Stop input and release the owning Session’s native capture and control resources.',
  },
  inputSchemas: COMPUTER_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: COMPUTER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
