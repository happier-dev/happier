import type {
  SessionAuthService,
  SessionRuntimeAuthRefreshRequest,
} from '@happier-dev/plugin-sdk/sessions';

import type { CodexAppServerRuntimeHost } from './runtime.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type AssertTrue<Value extends true> = Value;
type AssertNever<Value extends never> = Value;

type RuntimeAuthRefresh = NonNullable<CodexAppServerRuntimeHost['refreshRuntimeAuth']>;
type RuntimeAuthRefreshRequest = Parameters<RuntimeAuthRefresh>[0];
type SessionRuntimeAuthRefreshResult = Awaited<
  ReturnType<SessionAuthService['services']['refreshRuntimeAuth']>
>;

type _RuntimeAuthRefreshRequestMustUseCanonicalSessionContract = AssertTrue<
  Equal<RuntimeAuthRefreshRequest, SessionRuntimeAuthRefreshRequest>
>;
type _RuntimeAuthRefreshRequestMustNotExposeAgentIdentity = AssertNever<
  Extract<keyof RuntimeAuthRefreshRequest, 'agentId'>
>;
type _RuntimeAuthRefreshResultMustUseCanonicalSessionContract = AssertTrue<
  Equal<Awaited<ReturnType<RuntimeAuthRefresh>>, SessionRuntimeAuthRefreshResult>
>;
