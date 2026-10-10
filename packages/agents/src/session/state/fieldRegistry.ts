import type { SessionStateFieldId } from '@happier-dev/protocol';

import type { SessionStateFieldDescriptor } from './_types.js';

export const SESSION_STATE_FIELD_REGISTRY = {
  'intent.memoryEnabled': { id: 'intent.memoryEnabled', class: 'intent', conflictPolicy: 'bindingOwned', deliveryClass: 'durable_required' },
  'intent.voicePreference': { id: 'intent.voicePreference', class: 'intent', conflictPolicy: 'bindingOwned', deliveryClass: 'durable_required' },
  'intent.context': { id: 'intent.context', class: 'intent', conflictPolicy: 'bindingOwned', deliveryClass: 'durable_required' },
  'intent.sessionRoles': {
    id: 'intent.sessionRoles',
    class: 'intent',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_required',
  },
  'intent.role': {
    id: 'intent.role',
    class: 'intent',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_required',
  },
  'identity.runtimeDescriptor': {
    id: 'identity.runtimeDescriptor',
    class: 'identity',
    conflictPolicy: 'fingerprintPublication',
    deliveryClass: 'durable_best_effort',
  },
  'identity.providerSessionId': {
    id: 'identity.providerSessionId',
    class: 'identity',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_best_effort',
  },
  'intent.model': {
    id: 'intent.model',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'intent.permissionMode': {
    id: 'intent.permissionMode',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'intent.acpSessionMode': {
    id: 'intent.acpSessionMode',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'intent.acpConfigOption': {
    id: 'intent.acpConfigOption',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'display.title': {
    id: 'display.title',
    class: 'display',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'display.bot': {
    id: 'display.bot',
    class: 'display',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'durable_best_effort',
  },
  'runtime.workState': {
    id: 'runtime.workState',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_required',
  },
  'runtime.activity': {
    id: 'runtime.activity',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_best_effort',
  },
  'runtime.externalAgent': {
    id: 'runtime.externalAgent',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_best_effort',
  },
  'runtime.externalSessionOperation': {
    id: 'runtime.externalSessionOperation',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_required',
  },
  'runtime.usageLimitRecovery': {
    id: 'runtime.usageLimitRecovery',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_required',
  },
  'runtime.sessionRunner': {
    id: 'runtime.sessionRunner',
    class: 'runtime',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_best_effort',
  },
  'view.readState': {
    id: 'view.readState',
    class: 'view',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'ephemeral_drop_ok',
  },
  'view.attention': {
    id: 'view.attention',
    class: 'view',
    conflictPolicy: 'timestampedFieldUpdate',
    deliveryClass: 'ephemeral_drop_ok',
  },
  'view.transcriptToolCalls': {
    id: 'view.transcriptToolCalls',
    class: 'view',
    conflictPolicy: 'bindingOwned',
    deliveryClass: 'durable_best_effort',
  },
} satisfies { readonly [F in SessionStateFieldId]: SessionStateFieldDescriptor<F> };

export function getSessionStateFieldDescriptor<F extends SessionStateFieldId>(
  fieldId: F,
): SessionStateFieldDescriptor<F> {
  return SESSION_STATE_FIELD_REGISTRY[fieldId] as SessionStateFieldDescriptor<F>;
}
