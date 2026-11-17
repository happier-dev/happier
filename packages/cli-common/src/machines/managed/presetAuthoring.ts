import type { ActionExecutorDeps, ActionExecuteFailure, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetGetResultV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { captureManagedMachinePresetAuthorEffectReviewV1, projectManagedMachinePresetForRecipientV1,
  type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
  readMachineProvisionerSelectionForLaunchV1, requiresMachineProvisionerEffectReviewV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachinePresetSavedSecretPromotionReaderV1 } from './presetSavedSecretPromotion.js';
import { qualifyManagedOpaquePresetProvisionerV1, type ManagedProvisionerSelectionRead } from './provisioners.js';

function readAuthoredConfiguration(content: ManagedMachinePresetContentV1) {
  if (content.launch === undefined) return { setup: content.setup };
  // Physical guest names are display metadata, just as in the private prepared binding.
  const { name: _name, ...launch } = content.launch;
  return { launch, setup: content.setup };
}

/** The author captures native source effects into the exact carrier reviewed by Save. */
export async function prepareManagedMachinePresetAuthoringV1(
  request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
  deps: Readonly<{
    custody: Pick<ManagedMachinePresetSavedSecretPromotionReaderV1, 'accountId' | 'open' | 'withE2eeAccountKey'>;
    readSelectedProvisioners: ManagedProvisionerSelectionRead;
    randomBytes(length: number): Uint8Array;
  }>,
): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure | null> {
  if (request.actionId !== 'machines.presets.create' && request.actionId !== 'machines.presets.update') return null;
  const input = MachinePresetActionInputSchemasV1[request.actionId].parse(request.input);
  if (request.approvalReplay === true) return null;
  const value = 'patch' in input ? input.patch : input;
  if (!value.content) {
    if ('patch' in input && (input.patch.configurationRevision !== undefined || input.patch.setupRevision !== undefined)) {
      const { configurationRevision: _configurationRevision, setupRevision: _setupRevision, ...patch } = input.patch;
      return { children: [], input: { ...input, patch } };
    }
    return null;
  }
  const failure = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
  let incumbent: ManagedMachinePresetV1 | undefined;
  if ('patch' in input) {
    if (!request.invokeChild) return failure('admission_unavailable');
    const read = await request.invokeChild({ action: 'machines.presets.get', role: 'preset-authoring-read',
      input: { homeId: input.homeId, id: input.id } });
    if (!read.ok) return read;
    const found = ManagedMachinePresetGetResultV1Schema.safeParse(read.result);
    if (!found.success) return failure('managed_response_invalid');
    if (found.data.kind !== 'found') return failure(found.data.code);
    if (found.data.preset.revision !== input.expectedRevision) return failure('request_conflict');
    incumbent = found.data.preset;
  }
  const mode = value.contentEncryptionMode ?? incumbent?.contentEncryptionMode ?? (value.content.t === 'plain' ? 'plain' : 'e2ee');
  const recipients = value.recipients ?? incumbent?.recipients ?? [];
  const projection = projectManagedMachinePresetForRecipientV1({ content: value.content, recipients,
    recipientAccountId: deps.custody.accountId });
  const content = await deps.custody.open({ presetId: input.id, mode, projection });
  if (!content) return failure('content_unavailable');
  const previous = incumbent && await deps.custody.open({ presetId: input.id, mode: incumbent.contentEncryptionMode,
    projection: projectManagedMachinePresetForRecipientV1({ content: incumbent.content, recipients: incumbent.recipients,
      recipientAccountId: deps.custody.accountId }) });
  if (incumbent && !previous) return failure('content_unavailable');
  const configurationRevision = incumbent && previous ? (incumbent.configurationRevision ?? 0)
    + (sameStrictJsonValue(readAuthoredConfiguration(previous), readAuthoredConfiguration(content),
      { omitUndefinedObjectMembers: true }) ? 0 : 1) : 0;
  const setupRevision = incumbent && previous ? (incumbent.setupRevision ?? 0)
    + (sameStrictJsonValue(previous.setup ?? {}, content.setup ?? {}, { omitUndefinedObjectMembers: true }) ? 0 : 1) : 0;
  const preparedInput = 'patch' in input ? { ...input, patch: { ...input.patch, configurationRevision, setupRevision } }
    : { ...input, configurationRevision, setupRevision };
  const prepared: HostReviewedChildrenPreparationV1 = { children: [], input: preparedInput };
  if (!content.launch) return prepared;
  if (content.authorEffectReview) {
    if (previous && sameStrictJsonValue(previous.launch, content.launch)
      && sameStrictJsonValue(previous.authorEffectReview, content.authorEffectReview)) return prepared;
    return failure('invalid_request');
  }
  const entries = await deps.readSelectedProvisioners(content.launch.provider.pluginId);
  const descriptor = entries && qualifyManagedOpaquePresetProvisionerV1({ launch: content.launch, provisioners: entries });
  if (!descriptor) return failure('provider_unavailable');
  if (!requiresMachineProvisionerEffectReviewV1(descriptor, content.launch.choices)) return prepared;
  if (!request.invokeChild) return failure('admission_unavailable');
  const controller = value.controller === undefined ? incumbent?.controller : value.controller;
  const native = await request.invokeChild({ action: 'machines.provisioners.options', role: 'preset-authoring-review', input: {
    homeId: input.homeId, contribution: content.launch.provider,
    ...(controller ? { controller } : {}),
    ...(content.launch.credentials ? { credentials: content.launch.credentials } : {}),
    selectors: content.launch.choices,
  } });
  if (!native.ok) return native;
  const options = MachineProvisionerOptionsResultV1Schema.safeParse(native.result);
  if (!options.success) return failure('managed_response_invalid');
  const optionProjection = projectMachineProvisionerSelectionV1({ options: options.data,
    selection: readMachineProvisionerSelectionForLaunchV1(options.data, content.launch.choices), launchSchema: descriptor.launchSchema });
  const capture = { presetId: input.id, content: value.content, optionProjection };
  const captured = mode === 'plain' ? captureManagedMachinePresetAuthorEffectReviewV1({ ...capture, mode })
    : await deps.custody.withE2eeAccountKey(key => captureManagedMachinePresetAuthorEffectReviewV1({ ...capture,
      mode: 'e2ee', recipients, ...key, randomBytes: deps.randomBytes }));
  if (!captured) return failure('content_unavailable');
  return { children: [], input: 'patch' in preparedInput ? { ...preparedInput, patch: { ...preparedInput.patch,
    contentEncryptionMode: mode, recipients, content: captured } }
    : { ...preparedInput, content: captured }, approvalPreview: projectNativeJsonValueForTransport({ authorEffectReview: optionProjection.effectReview }) };
}
