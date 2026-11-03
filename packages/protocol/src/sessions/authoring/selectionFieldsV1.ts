import { z } from 'zod/mini';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../metadata/metadataOverridesV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';
import { SessionAuthoringTerminalV1Schema } from './creationFieldsV1.js';
import { ApprovalProfileIdV1Schema } from '../../actions/approvalProfiles.js';

/** Shared selection schemas stay below the catalog: a catalogued birth trigger contains a Workflow. */
export const SessionAuthoringSelectionFieldsV1 = {
  ...AgentSessionToolPolicyShapeV1,
  agentTarget: z.nullable(AgentExecutionTargetV1Schema),
  profileId: z.nullable(z.string()),
  approvalProfileId: z.nullable(ApprovalProfileIdV1Schema),
  permissionMode: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  acpSessionModeId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  sessionConfigOptionOverrides: z.nullable(AcpConfigOptionOverridesV1Schema),
  capabilitySelection: z.nullable(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.nullable(z.enum(['persisted', 'direct'])),
  terminal: z.nullable(SessionAuthoringTerminalV1Schema),
  windowsRemoteSessionLaunchMode: z.nullable(WindowsRemoteSessionLaunchModeSchema),
  windowsRemoteSessionConsole: z.nullable(z.enum(['hidden', 'visible'])),
  windowsTerminalWindowName: z.nullable(WindowsTerminalWindowNameSchema),
} as const;
