import type { SessionStateFieldId } from '@happier-dev/protocol';

import type { SessionStateFieldDescriptor } from './_types.js';

export const SESSION_STATE_FIELD_REGISTRY = {
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
} satisfies { readonly [F in SessionStateFieldId]: SessionStateFieldDescriptor<F> };

export function getSessionStateFieldDescriptor<F extends SessionStateFieldId>(
  fieldId: F,
): SessionStateFieldDescriptor<F> {
  return SESSION_STATE_FIELD_REGISTRY[fieldId] as SessionStateFieldDescriptor<F>;
}
