import { PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { CoderClient } from './nativeClient.js';
import { BILLING, RETENTION, type CoderOptions } from './schemas.js';

const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const templatesSchema = defineProtocolArray(defineProtocolObject({ id: text, name: text, display_name: defineProtocolString().optional(),
  organization_id: text, active_version_id: text }, open));
const parametersSchema = defineProtocolArray(defineProtocolObject({ name: text, required: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]), default_value: defineProtocolString() }, open));
// v2.39.0 codersdk/presets.go uses exported Go field names without JSON tags.
// A preset with no parameters has a nil slice, encoded as null.
const presetsSchema = defineProtocolArray(defineProtocolObject({ ID: text, Name: text,
  Parameters: defineProtocolUnion([defineProtocolArray(defineProtocolObject({ Name: text, Value: defineProtocolString() }, open)), defineProtocolLiteral(null)]),
  DesiredPrebuildInstances: defineProtocolUnion([defineProtocolNumber({ integer: true, minimum: 0 }), defineProtocolLiteral(null)]).optional(),
}, open));
const emptyDimensions = () => ({ size: [], image: [], location: [], network: [], duration: [] });

/** Coder templates are images in the existing options model. Rich values use
 * the ordinary JSON editor; Terraform's conditional forms remain Coder-owned. */
export async function coderOptions(client: CoderClient, query: CoderOptions): Promise<MachineProvisionerOptionsResultV1> {
  if (!query.organizationId) return { dimensions: emptyDimensions() };
  const templates = templatesSchema.parse(await client.request('/organizations/' + encodeURIComponent(query.organizationId) + '/templates'));
  if (templates.some(template => template.organization_id !== query.organizationId)) throw new PluginError({ code: 'resource_mismatch' });
  const chosen = templates.find(template => template.id === query.templateId);
  if (query.templateId && !chosen) throw new PluginError({ code: 'invalid_request', message: 'The selected Coder template is unavailable in this organization.' });
  const versionId = query.templateVersionId ?? chosen?.active_version_id;
  const values = new Map<string, string>();
  let missing: string[] = [];
  let prebuildDescription = 'Coder can claim a matching native prebuild or build a fresh workspace. Select a preset to inspect its configuration; set prebuilds in Coder to configure a pool. Only unsatisfied setup runs afterward; No Setup skips CLI installation.';
  if (chosen && versionId) {
    await client.qualifyTemplateVersion({ templateVersionId: versionId, templateId: chosen.id, organizationId: query.organizationId });
    const parameters = parametersSchema.parse(await client.request('/templateversions/' + encodeURIComponent(versionId) + '/rich-parameters'));
    // An empty required default means Coder expects a supplied value. Do not
    // silently insert that placeholder or manufacture a provider default.
    for (const parameter of parameters) if (parameter.default_value !== '' || !parameter.required) values.set(parameter.name, parameter.default_value);
    if (query.presetId) {
      const presets = presetsSchema.parse(await client.request('/templateversions/' + encodeURIComponent(versionId) + '/presets'));
      const preset = presets.find(item => item.ID === query.presetId);
      if (!preset) throw new PluginError({ code: 'invalid_request', message: 'The selected Coder preset is unavailable for this template version.' });
      // This is native configuration, never a ready-capacity or baked-CLI claim.
      prebuildDescription = preset.DesiredPrebuildInstances == null
        ? 'Native prebuild preparation is not supported for this preset configuration. Set prebuilds in Coder. Ordinary workspace creation remains available.'
        : `Coder native prebuilds are configured for this preset (base target ${preset.DesiredPrebuildInstances}; schedules may change it). Coder claims an eligible prebuild or builds fresh. Only unsatisfied setup runs afterward; No Setup skips CLI installation.`;
      for (const parameter of preset.Parameters ?? []) values.set(parameter.Name, parameter.Value);
    }
    for (const parameter of query.parameterValues ?? []) values.set(parameter.name, parameter.value);
    missing = parameters.filter(parameter => parameter.required && !values.has(parameter.name)).map(parameter => parameter.name);
  } else for (const parameter of query.parameterValues ?? []) values.set(parameter.name, parameter.value);
  const launch = { organizationId: query.organizationId,
    ...(chosen && versionId ? { templateId: chosen.id, templateVersionId: versionId } : {}),
    ...(query.agentName ? { agentName: query.agentName } : {}),
    ...(query.presetId ? { presetId: query.presetId } : {}),
    ...(query.workspaceHost ? { workspaceHost: query.workspaceHost } : {}),
    parameterValues: [...values].map(([name, value]) => ({ name, value })),
  };
  return { base: { launch, billing: BILLING, retention: RETENTION,
    ...(missing.length ? { available: false, unavailableReason: { code: 'invalid_request', fieldPath: 'parameterValues', status: `Supply required Coder parameters: ${missing.join(', ')}.` } } : {}),
  }, dimensions: { ...emptyDimensions(), image: templates.map(template => ({ id: template.id, title: template.display_name || template.name,
    ...(template.id === chosen?.id ? { nativeFacts: { image: { id: template.id, title: template.display_name || template.name, description: prebuildDescription } } } : {}),
    assignments: [{ path: 'templateId', value: template.id }, { path: 'templateVersionId', value: template.id === chosen?.id && versionId ? versionId : template.active_version_id },
      // A host declaration belongs to one selected template/version. Choosing
      // another template clears it rather than reusing that locality claim.
      ...(template.id === chosen?.id ? [] : [{ path: 'workspaceHost', value: 'unknown' }])],
  })) } };
}
