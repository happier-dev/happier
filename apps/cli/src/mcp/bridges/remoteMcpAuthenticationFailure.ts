import { z } from 'zod/mini';

// Private bridge → native MCP client initialize failure. Carries no remote content.
export const RemoteMcpAuthenticationFailureSchema = z.strictObject({
  t: z.literal('happier-mcp-remote-authentication-required-v1'),
  code: z.literal('mcp_sign_in_required'),
});
export class RemoteMcpAuthenticationRequiredError extends Error {
  readonly data = RemoteMcpAuthenticationFailureSchema.parse({
    t: 'happier-mcp-remote-authentication-required-v1', code: 'mcp_sign_in_required',
  });
  constructor() { super('mcp_sign_in_required'); }
}
