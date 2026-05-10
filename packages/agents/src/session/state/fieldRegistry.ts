import type { SessionStateFieldId } from '@happier-dev/protocol';

import type { SessionStateFieldDescriptor } from './_types.js';

export const SESSION_STATE_FIELD_REGISTRY = {
  'identity.runtimeDescriptor': {
    id: 'identity.runtimeDescriptor',
    class: 'identity',
    conflictPolicy: 'fingerprintPublication',
  },
  'identity.vendorSessionId': {
    id: 'identity.vendorSessionId',
    class: 'identity',
    conflictPolicy: 'bindingOwned',
  },
  'intent.model': {
    id: 'intent.model',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'intent.permissionMode': {
    id: 'intent.permissionMode',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'intent.acpSessionMode': {
    id: 'intent.acpSessionMode',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'intent.acpConfigOption': {
    id: 'intent.acpConfigOption',
    class: 'intent',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'display.title': {
    id: 'display.title',
    class: 'display',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'view.readState': {
    id: 'view.readState',
    class: 'view',
    conflictPolicy: 'timestampedFieldUpdate',
  },
  'view.attention': {
    id: 'view.attention',
    class: 'view',
    conflictPolicy: 'timestampedFieldUpdate',
  },
} satisfies { readonly [F in SessionStateFieldId]: SessionStateFieldDescriptor<F> };

export function getSessionStateFieldDescriptor<F extends SessionStateFieldId>(
  fieldId: F,
): SessionStateFieldDescriptor<F> {
  return SESSION_STATE_FIELD_REGISTRY[fieldId] as SessionStateFieldDescriptor<F>;
}
