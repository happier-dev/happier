import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { z } from 'zod';

import type { SessionProviderInputConsumer } from './_types';

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
}>): void {
  params.rpcHandlerRegistrar.registerHandler(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
    async (raw: unknown) => {
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
      return await params.consumer.clearProviderInputAdmission(request);
    },
  );
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
