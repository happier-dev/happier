import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod';

import type { SessionProviderInputConsumer } from './_types';

export const SessionInputLiveWorkSchema = z.object({
  session: z.enum(['active', 'settled', 'unknown']),
  input: z.enum(['active', 'settled', 'unknown']),
}).strict();

const groupEnforceSchema = z.object({
  action: z.literal('enforce'),
  serviceId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  reason: z.enum(['group_unavailable', 'generation_pending']).optional(),
  epochId: z.string().trim().min(1).optional(),
});
const admissionRequestSchema = z.union([
  groupEnforceSchema,
  z.object({
    action: z.literal('clear'),
    serviceId: z.string().trim().min(1),
    groupId: z.string().trim().min(1),
    epochId: z.string().trim().min(1).optional(),
    applicationSettled: z.literal(true).optional(),
  }),
]).superRefine((request, ctx) => {
  if (
    request.action === 'enforce'
    && 'serviceId' in request
    && request.reason === 'generation_pending'
    && !request.epochId
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'generation_pending requires epochId' });
  }
});

type AdmissionRequest = z.infer<typeof admissionRequestSchema>;

export function registerSessionProviderInputAdmissionRpc<Mode, Message>(params: Readonly<{
  consumer: SessionProviderInputConsumer<Mode, Message>;
  rpcHandlerRegistrar: RpcHandlerRegistrar;
  onApplicationSettled?: (request: Readonly<{
    serviceId: string;
    groupId: string;
  }>) => Promise<void>;
}>): void {
  params.rpcHandlerRegistrar.registerHandler(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
    async (raw: unknown) => {
      const activityRead = z.object({ action: z.literal('activity_read') }).strict().safeParse(raw);
      if (activityRead.success) return SessionInputLiveWorkSchema.parse(await params.consumer.readLiveWork());
      const request = admissionRequestSchema.parse(raw);
      if (request.action === 'enforce') {
        const disposition = request.reason === 'generation_pending'
          ? {
              kind: 'action_required' as const,
              reason: 'generation_pending' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
              epochId: request.epochId!,
            }
          : {
              kind: 'action_required' as const,
              reason: 'group_unavailable' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
            };
        await params.consumer.enforceProviderInputAdmission(disposition);
        return { status: 'enforced' as const };
      }
      const result = await params.consumer.clearProviderInputAdmission(request);
      if (result.status === 'cleared' && request.applicationSettled === true) {
        await params.onApplicationSettled?.({
          serviceId: request.serviceId,
          groupId: request.groupId,
        }).catch(() => undefined);
      }
      return result;
    },
  );
}

/** Read-only projection from the live host; unavailable predecessors remain unknown at the caller. */
export async function requestSessionInputLiveWork(params: Readonly<{
  callRpc: (method: string, request: Readonly<{ action: 'activity_read' }>) => Promise<unknown>;
}>): Promise<z.infer<typeof SessionInputLiveWorkSchema>> {
  return SessionInputLiveWorkSchema.parse(await params.callRpc(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, { action: 'activity_read' },
  ));
}

export async function requestSessionProviderInputAdmission(params: Readonly<{
  callRpc: (method: string, request: AdmissionRequest) => Promise<unknown>;
}> & AdmissionRequest): Promise<Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>> {
  const request = admissionRequestSchema.parse(params);
  const raw = await params.callRpc(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request);
  const result = z.object({ status: z.enum(['enforced', 'cleared', 'not_matched']) }).parse(raw);
  if (request.action === 'enforce' && result.status !== 'enforced') {
    throw new Error('provider_input_admission_not_enforced');
  }
  return result;
}
