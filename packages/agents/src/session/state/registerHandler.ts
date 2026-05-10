import type {
  SessionStateCapabilitiesV1,
  SessionStateFieldId,
  SessionStateFieldValue,
} from '@happier-dev/protocol';

import type {
  RuntimeFacetCtx,
  SessionStateApplyReason,
  SessionStateDisposable,
  SessionStateFacet,
} from './_types.js';

export type SessionStateProviderFieldHandler<F extends SessionStateFieldId = SessionStateFieldId> = Readonly<{
  applyHappierField?: (
    ctx: RuntimeFacetCtx,
    value: SessionStateFieldValue<F>,
    opts: Readonly<{ reason: SessionStateApplyReason }>,
  ) => Promise<void>;
  readField?: (ctx: RuntimeFacetCtx) => Promise<SessionStateFieldValue<F> | null>;
  observeField?: (
    ctx: RuntimeFacetCtx,
    emit: (value: SessionStateFieldValue<F>) => void,
  ) => SessionStateDisposable;
}>;

export type SessionStateProviderHandlerMap = Partial<{
  [F in SessionStateFieldId]: SessionStateProviderFieldHandler<F>;
}>;

export function createSessionStateFacetFromHandlers(
  handlers: SessionStateProviderHandlerMap,
  options?: Readonly<{ capabilities?: SessionStateCapabilitiesV1 }>,
): SessionStateFacet {
  return {
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
    applyHappierField: async (ctx, field, value, opts) => {
      const handler = handlers[field] as SessionStateProviderFieldHandler<typeof field> | undefined;
      if (!handler?.applyHappierField) {
        throw Object.assign(new Error(`Session state field is not writable by provider: ${field}`), {
          code: 'unsupported',
        });
      }
      await handler.applyHappierField(ctx, value, opts);
    },
    readField: async (ctx, field) => {
      const handler = handlers[field] as SessionStateProviderFieldHandler<typeof field> | undefined;
      if (!handler?.readField) {
        throw Object.assign(new Error(`Session state field is not readable by provider: ${field}`), {
          code: 'unsupported',
        });
      }
      return handler.readField(ctx);
    },
    observeField: (ctx, field, emit) => {
      const handler = handlers[field] as SessionStateProviderFieldHandler<typeof field> | undefined;
      if (!handler?.observeField) {
        throw Object.assign(new Error(`Session state field is not observable by provider: ${field}`), {
          code: 'unsupported',
        });
      }
      return handler.observeField(ctx, emit);
    },
  };
}
