import { describe, expect, it } from 'vitest';

import {
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1,
  materializeRecipientOperationRequestV1,
  normalizeRecipientContractV1,
  resolveRequiredRecipientContractApprovalDigestV1,
  serializeRecipientContractV1,
} from './recipientContractV1.js';

const input = {
  version: 1 as const,
  package: {
    pluginId: 'com.acme.voice',
    source: { kind: 'package' as const, locator: '@acme/voice' },
  },
  publisher: {
    trust: 'verified' as const,
    identity: 'npm:https://registry.npmjs.org:@acme',
  },
  contribution: {
    pluginId: 'com.acme.voice',
    localId: 'conversation',
  },
  credentialSlot: {
    id: 'api-key',
    scope: 'account' as const,
  },
  operations: [{
    id: 'mint-client-auth',
    purpose: 'voice.client-auth',
    credentialSlotId: 'api-key',
    effect: 'read' as const,
    request: {
      origin: 'https://api.example.com',
      pathTemplate: '/v1/conversations/{agentId}/token',
      queryTemplate: [{ name: 'mode', value: 'realtime' }],
      headerTemplate: [{ name: 'accept', value: 'application/json' }],
      bodyTemplate: { kind: 'none' as const },
      method: 'GET' as const,
      credential: { kind: 'httpHeader' as const, name: 'x-api-key', format: 'raw' as const },
      redirect: 'error' as const,
      maxBodyBytes: 0,
      contentTypes: [],
    },
    parameters: {
      schema: {
        type: 'object' as const,
        properties: { agentId: { type: 'string' as const, minLength: 1, maxLength: 256 } },
        required: ['agentId'],
        additionalProperties: false,
      },
      mapping: [{
        parameter: 'agentId',
        target: { kind: 'path' as const, placeholder: 'agentId', encoding: 'uri_component' as const },
      }],
    },
    response: {
      maxBytes: 32_768,
      contentTypes: ['application/json'],
    },
  }],
};

describe('RecipientContractV1', () => {
  it('projects the final Voice credentials owner without reconstructing account mediation', () => {
    expect(createVoiceProviderRecipientContractFromCredentialsV1({
      package: input.package,
      publisher: input.publisher,
      contribution: input.contribution,
      credentials: {
        slot: { id: 'api-key' },
        hostMediated: { operations: input.operations },
      },
    })).toEqual(normalizeRecipientContractV1(input));
  });

  it('has a stable canonical serialization and digest golden vector', () => {
    const normalized = normalizeRecipientContractV1(input);
    expect(serializeRecipientContractV1(normalized)).toBe(
      '{"contribution":{"localId":"conversation","pluginId":"com.acme.voice"},"credentialSlot":{"id":"api-key","scope":"account"},"operations":[{"credentialSlotId":"api-key","effect":"read","id":"mint-client-auth","parameters":{"mapping":[{"parameter":"agentId","target":{"encoding":"uri_component","kind":"path","placeholder":"agentId"}}],"schema":{"additionalProperties":false,"properties":{"agentId":{"maxLength":256,"minLength":1,"type":"string"}},"required":["agentId"],"type":"object"}},"purpose":"voice.client-auth","request":{"bodyTemplate":{"kind":"none"},"contentTypes":[],"credential":{"format":"raw","kind":"httpHeader","name":"x-api-key"},"headerTemplate":[{"name":"accept","value":"application/json"}],"maxBodyBytes":0,"method":"GET","origin":"https://api.example.com","pathTemplate":"/v1/conversations/{agentId}/token","queryTemplate":[{"name":"mode","value":"realtime"}],"redirect":"error"},"response":{"contentTypes":["application/json"],"maxBytes":32768}}],"package":{"pluginId":"com.acme.voice","source":{"kind":"package","locator":"@acme/voice"}},"publisher":{"identity":"npm:https://registry.npmjs.org:@acme","trust":"verified"},"version":1}',
    );
    expect(createRecipientContractDigestV1(normalized)).toBe(
      'sha256:cc4abb33445788f71a46e67333cd2776044d6d7fa3ef7176aac243ebc600f1db',
    );
  });

  it('fences a stored approval only for a publisher that could rewrite the contract', () => {
    const verified = normalizeRecipientContractV1(input);
    expect(resolveRequiredRecipientContractApprovalDigestV1(verified))
      .toBe(createRecipientContractDigestV1(verified));

    // A bundled recipient ships inside the same binary that enforces it, so an
    // update that changes its mediated operations must not revoke an approval
    // the user already gave for a contract Happier itself authored.
    const bundled = normalizeRecipientContractV1({
      ...input,
      publisher: { trust: 'bundled' as const, identity: 'happier.dev:first-party-bundle' },
    });
    expect(resolveRequiredRecipientContractApprovalDigestV1(bundled)).toBeNull();
  });

  it('sorts operation and template sets while retaining every executable security field', () => {
    const baseline = createRecipientContractDigestV1(input);
    const localizedPresentationChange = createRecipientContractDigestV1({
      ...input,
      presentation: { title: 'Localized presentation only' },
    });
    expect(localizedPresentationChange).toBe(baseline);

    const mutations: unknown[] = [
      {
        ...input,
        package: { ...input.package, pluginId: 'com.acme.other' },
        contribution: { ...input.contribution, pluginId: 'com.acme.other' },
      },
      { ...input, publisher: { ...input.publisher, identity: 'npm:other' } },
      { ...input, contribution: { ...input.contribution, localId: 'other' } },
      {
        ...input,
        credentialSlot: { ...input.credentialSlot, id: 'other' },
        operations: [{ ...input.operations[0], credentialSlotId: 'other' }],
      },
      { ...input, operations: [{ ...input.operations[0], purpose: 'voice.catalog' }] },
      { ...input, operations: [{ ...input.operations[0], effect: 'mutation' }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, origin: 'https://other.example.com' } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, pathTemplate: '/other/{agentId}' } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, queryTemplate: [{ name: 'mode', value: 'batch' }] } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, headerTemplate: [{ name: 'accept', value: 'text/plain' }] } }] },
      {
        ...input,
        operations: [{
          ...input.operations[0],
          request: {
            ...input.operations[0].request,
            method: 'POST',
            bodyTemplate: { kind: 'json', value: { mode: 'realtime' } },
          },
        }],
      },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, method: 'POST' } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, credential: { ...input.operations[0].request.credential, name: 'authorization' } } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, maxBodyBytes: 1 } }] },
      { ...input, operations: [{ ...input.operations[0], request: { ...input.operations[0].request, contentTypes: ['application/json'] } }] },
      { ...input, operations: [{ ...input.operations[0], parameters: { ...input.operations[0].parameters, schema: { ...input.operations[0].parameters.schema, required: [] } } }] },
      {
        ...input,
        operations: [{
          ...input.operations[0],
          request: { ...input.operations[0].request, pathTemplate: '/v1/conversations/token' },
          parameters: {
            ...input.operations[0].parameters,
            mapping: [{ parameter: 'agentId', target: { kind: 'query', name: 'agent_id' } }],
          },
        }],
      },
      { ...input, operations: [{ ...input.operations[0], response: { ...input.operations[0].response, maxBytes: 65_536 } }] },
      { ...input, operations: [{ ...input.operations[0], response: { ...input.operations[0].response, contentTypes: ['application/cbor'] } }] },
    ];
    for (const mutation of mutations) {
      expect(createRecipientContractDigestV1(mutation), JSON.stringify(mutation)).not.toBe(baseline);
    }
  });

  it('rejects undeclared mappings, non-canonical origins, and credential header templates', () => {
    expect(() => normalizeRecipientContractV1({
      ...input,
      operations: [{
        ...input.operations[0],
        parameters: {
          ...input.operations[0].parameters,
          mapping: [{ parameter: 'missing', target: { kind: 'query', name: 'agent_id' } }],
        },
      }],
    })).toThrow();
    expect(() => normalizeRecipientContractV1({
      ...input,
      operations: [{
        ...input.operations[0],
        request: { ...input.operations[0].request, origin: 'https://api.example.com/path' },
      }],
    })).toThrow();
    expect(() => normalizeRecipientContractV1({
      ...input,
      operations: [{
        ...input.operations[0],
        request: {
          ...input.operations[0].request,
          headerTemplate: [{ name: 'x-api-key', value: 'forbidden' }],
        },
      }],
    })).toThrow();
  });

  it('omits absent optional query and header mappings while encoding present values', () => {
    const contract = {
      ...input,
      operations: [{
        ...input.operations[0],
        request: {
          ...input.operations[0].request,
          pathTemplate: '/v1/tools',
          queryTemplate: [{ name: 'page_size', value: '100' }],
        },
        parameters: {
          schema: {
            type: 'object' as const,
            properties: {
              cursor: { type: 'string' as const, minLength: 1, maxLength: 512 },
              requestId: { type: 'string' as const, minLength: 1, maxLength: 128 },
            },
            additionalProperties: false,
          },
          mapping: [
            { parameter: 'cursor', target: { kind: 'query' as const, name: 'cursor' } },
            { parameter: 'requestId', target: { kind: 'header' as const, name: 'x-request-id' } },
          ],
        },
      }],
    };

    const firstPage = materializeRecipientOperationRequestV1({
      contract,
      operationId: 'mint-client-auth',
      parameters: {},
    });
    expect(firstPage.url).toBe('https://api.example.com/v1/tools?page_size=100');
    expect(firstPage.headers).toEqual({ accept: 'application/json' });

    const nextPage = materializeRecipientOperationRequestV1({
      contract,
      operationId: 'mint-client-auth',
      parameters: { cursor: 'page/2', requestId: 'request-2' },
    });
    expect(nextPage.url).toBe('https://api.example.com/v1/tools?page_size=100&cursor=page%2F2');
    expect(nextPage.headers).toEqual({ accept: 'application/json', 'x-request-id': 'request-2' });
  });

  it('materializes a bounded bodyless DELETE recipient operation', () => {
    const contract = {
      ...input,
      operations: [{
        ...input.operations[0],
        id: 'delete-tool',
        purpose: 'voice.provision.tool.delete',
        effect: 'mutation' as const,
        request: {
          ...input.operations[0].request,
          pathTemplate: '/v1/convai/tools/{toolId}',
          queryTemplate: [{ name: 'force', value: 'false' }],
          bodyTemplate: { kind: 'none' as const },
          method: 'DELETE' as const,
          maxBodyBytes: 0,
          contentTypes: [],
        },
        parameters: {
          schema: {
            type: 'object' as const,
            properties: { toolId: { type: 'string' as const, minLength: 1, maxLength: 256 } },
            required: ['toolId'],
            additionalProperties: false,
          },
          mapping: [{
            parameter: 'toolId',
            target: { kind: 'path' as const, placeholder: 'toolId', encoding: 'uri_component' as const },
          }],
        },
      }],
    };

    expect(materializeRecipientOperationRequestV1({
      contract,
      operationId: 'delete-tool',
      parameters: { toolId: 'tool/created' },
    })).toMatchObject({
      method: 'DELETE',
      url: 'https://api.example.com/v1/convai/tools/tool%2Fcreated?force=false',
      headers: { accept: 'application/json' },
      body: null,
      redirect: 'error',
    });
  });

  it('fails closed when an unresolved path mapping is optional in the parameter schema', () => {
    const contract = {
      ...input,
      operations: [{
        ...input.operations[0],
        parameters: {
          ...input.operations[0].parameters,
          schema: {
            ...input.operations[0].parameters.schema,
            required: [],
          },
        },
      }],
    };

    expect(() => materializeRecipientOperationRequestV1({
      contract,
      operationId: 'mint-client-auth',
      parameters: {},
    })).toThrow(TypeError);
  });

  it.each([
    '//attacker.example/collect',
    '/\\\\attacker.example/collect',
    '/v1/allowed/../collect',
    '/v1/%2e%2e/collect',
  ])('rejects authority-confusing or normalization-changing path template %s', (pathTemplate) => {
    const contract = {
      ...input,
      operations: [{
        ...input.operations[0],
        request: { ...input.operations[0].request, pathTemplate },
        parameters: {
          schema: { type: 'object' as const, properties: {}, additionalProperties: false },
          mapping: [],
        },
      }],
    };
    expect(() => normalizeRecipientContractV1(contract)).toThrow();
    expect(() => materializeRecipientOperationRequestV1({
      contract,
      operationId: 'mint-client-auth',
      parameters: {},
    })).toThrow();
  });
});
