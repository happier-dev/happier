import { expect, it } from 'vitest';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginJsonRpcClient } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { resolveMuseTurnInput } from './inputs.js';

// Native JSON-RPC is an external boundary; this file input requires no native lookup.
const unexpected = () => { throw new Error('Unexpected native RPC for a host-resolved file'); };
const client: PluginJsonRpcClient = { request: unexpected, notify: unexpected,
  onNotificationReceived: unexpected, onNotification: unexpected, onRequest: unexpected, dispose() {} };

it('sends host-resolved Channel file context without treating its dispatch metadata as native input', async () => {
  const prepared = await prepareSessionInputForProviderDispatch({
    prompt: { text: 'PEBBLE', localId: 'channel-input', structuredInput: { v: 1, composerAttachments: [{
      v: 1, instanceId: 'channel-file-1', attachment: { pluginId: 'happier.channels', localId: 'channel-file' },
      key: 'file-1', value: { fileId: 'file-1' }, presentation: { label: 'Channel file', typeLabel: 'Channel file' },
    }] } },
    transformedUserText: 'PEBBLE', providerNativeCommand: false,
    localId: 'channel-input', signal: new AbortController().signal,
    services: { sessionId: 'host-admitted-muse',
      // The daemon attachment RPC is the boundary; host projection/rendering and Muse remain real.
      resolveComposerAttachmentForDispatch: async input => ({ attachments: input.request.attachments.map(attachment => ({
        instanceId: attachment.instanceId, status: 'ready',
        context: '<happier_channel_attachment trust="untrusted" provenance="original">\nName: "lead.txt"\nText: "PEBBLE attachment content"\n</happier_channel_attachment>',
      })) }),
    },
  });
  expect(prepared.requiredPrompt).toContain('PEBBLE attachment content');
  expect(prepared.structuredInput).toHaveProperty('resolvedComposerAttachments');
  expect(await resolveMuseTurnInput({ text: prepared.requiredPrompt,
    structuredInput: AgentRuntimeJsonValueSchema.parse(prepared.structuredInput) }, {
    nativeSessionId: 'native-session', msp: { client },
  })).toEqual([{ type: 'text', text: prepared.requiredPrompt }]);
});
