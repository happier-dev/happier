import { lazyActionSpecArray } from './lazyActionSpecValue.js';
export { EXTERNAL_LINK_ACTION_IDS } from './externalLinkActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';
import { isRedactedPublicShareCapabilityUrl } from '../crypto/publicShareCapabilityUrl.js';

import type { PreNormalizedActionSpec } from './actionSpecs.js';
export const ExternalUrlOpenInputSchema = z.strictObject({
  url: z.string().check(z.regex(/^https?:\/\//i), z.refine(url => !isRedactedPublicShareCapabilityUrl(url),
    { message: 'A redacted link cannot be opened. Copy the issued link from the Share sheet.' })),
});
export const ExternalUrlOpenResultSchema = z.strictObject({ status: z.literal('opened') });

function createExternalLinkActionSpecs() {
  return [{
  id: 'links.openExternal', approval: { result: 'required' }, approvalPolicy: { agentDefault: 'egress', uiConfirmation: 'direct', requiredSurfaces: ['voice'] },
  title: 'Open an external link',
  description: 'Open an HTTP(S) URL in the answering client’s system browser. clientId selects an exact connected app. URLs stay private to this live invocation; an unavailable client or opener refuses without a headless fallback.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'links_open_external', voiceClientToolName: 'links_open_external' },
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [{ path: ['links', 'open-external'], visibility: 'canonical' }] },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: ExternalUrlOpenInputSchema, outputSchema: ExternalUrlOpenResultSchema,
  // OAuth state, verification codes and fragment tokens must never enter retained records.
  approvalInputCustody: 'live_only', projectObservationInput: () => ({}),
  approvalPresentation: { summary: () => 'Open an external link on the answering device. Its URL stays private to this live invocation.' },
  inputHints: { fields: [{ path: 'url', title: 'HTTP(S) URL', widget: 'text', required: true }] },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const EXTERNAL_LINK_ACTION_SPECS: ReturnType<typeof createExternalLinkActionSpecs> = lazyActionSpecArray(createExternalLinkActionSpecs);
