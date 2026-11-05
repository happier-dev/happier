import { defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

/** Native immutable commit grammar shared by hosted acquisition and local entry seeds. */
export const GithubWorkflowShaV1Schema = defineProtocolString({ pattern: '^[0-9a-fA-F]{40}$' });
