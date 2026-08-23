import axios from 'axios';
import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
  ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
  AccountApiTokensCreateActionInputV1Schema,
  AccountApiTokensCreateActionOutputV1Schema,
  AccountApiTokensListActionInputV1Schema,
  AccountApiTokensListActionOutputV1Schema,
  AccountApiTokensRevokeActionInputV1Schema,
  AccountApiTokensRevokeActionOutputV1Schema,
  AccountApiTokensRevokeAllActionInputV1Schema,
  AccountApiTokensRevokeAllActionOutputV1Schema,
  AccountSessionsSignOutEverywhereActionInputV1Schema,
  AccountSessionsSignOutEverywhereServerOutputV1Schema,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import type { z } from 'zod';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type AccountServerActionDeps = Pick<
  ActionExecutorDeps,
  | 'accountSessionsSignOutEverywhereAction'
  | 'accountApiTokensCreateAction'
  | 'accountApiTokensListAction'
  | 'accountApiTokensRevokeAction'
  | 'accountApiTokensRevokeAllAction'
>;

async function executeAccountServerAction<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(params: Readonly<{
  token: string;
  path: string;
  input: z.input<TInputSchema>;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  signal?: AbortSignal;
}>): Promise<z.output<TOutputSchema>> {
  const response = await axios.post<unknown>(
    `${resolveServerHttpBaseUrl()}${params.path}`,
    params.inputSchema.parse(params.input),
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    },
  );
  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while executing Account Action (${response.status})`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw createHttpStatusError(
      response.status,
      `Failed to execute Account Action (${response.status})`,
    );
  }
  return params.outputSchema.parse(response.data);
}

/**
 * Thin CLI/daemon adapter for Account-server-owned auth Actions. The canonical
 * ActionExecutor retains admission and authority decisions; this dependency
 * only reaches the existing Account-scoped HTTP owners with the daemon's
 * configured signed Account credential.
 */
export function createAccountServerActionDeps(input: Readonly<{
  token: string;
}>): AccountServerActionDeps {
  return {
    accountSessionsSignOutEverywhereAction: async ({ input: actionInput, signal }) =>
      await executeAccountServerAction({
        token: input.token,
        path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
        input: actionInput,
        inputSchema: AccountSessionsSignOutEverywhereActionInputV1Schema,
        outputSchema: AccountSessionsSignOutEverywhereServerOutputV1Schema,
        ...(signal ? { signal } : {}),
      }),
    accountApiTokensCreateAction: async ({ input: actionInput, signal }) =>
      await executeAccountServerAction({
        token: input.token,
        path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        input: actionInput,
        inputSchema: AccountApiTokensCreateActionInputV1Schema,
        outputSchema: AccountApiTokensCreateActionOutputV1Schema,
        ...(signal ? { signal } : {}),
      }),
    accountApiTokensListAction: async ({ input: actionInput, signal }) =>
      await executeAccountServerAction({
        token: input.token,
        path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        input: actionInput,
        inputSchema: AccountApiTokensListActionInputV1Schema,
        outputSchema: AccountApiTokensListActionOutputV1Schema,
        ...(signal ? { signal } : {}),
      }),
    accountApiTokensRevokeAction: async ({ input: actionInput, signal }) =>
      await executeAccountServerAction({
        token: input.token,
        path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        input: actionInput,
        inputSchema: AccountApiTokensRevokeActionInputV1Schema,
        outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
        ...(signal ? { signal } : {}),
      }),
    accountApiTokensRevokeAllAction: async ({ input: actionInput, signal }) =>
      await executeAccountServerAction({
        token: input.token,
        path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        input: actionInput,
        inputSchema: AccountApiTokensRevokeAllActionInputV1Schema,
        outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
        ...(signal ? { signal } : {}),
      }),
  };
}
