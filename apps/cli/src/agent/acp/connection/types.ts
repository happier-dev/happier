import {
  RequestError,
  type AgentApp,
  type ClientApp,
  type ParamsParser,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export type AcpClientTransport = Stream | AgentApp;

export type AcpClientConnectionHandlers = Readonly<{
  requestPermission: (
    params: RequestPermissionRequest,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  sessionUpdate: (params: SessionNotification) => void | Promise<void>;
  readTextFile?: (
    params: ReadTextFileRequest,
  ) => ReadTextFileResponse | Promise<ReadTextFileResponse>;
  writeTextFile?: (
    params: WriteTextFileRequest,
  ) => WriteTextFileResponse | Promise<WriteTextFileResponse>;
}>;

export type AcpExtensionHandlerContext = Readonly<{
  method: string;
  signal: AbortSignal;
  providerSessionId?: string;
  currentTurn?: Readonly<{
    turnId: string;
    submitCompletionEvidence(evidence: Readonly<{
      providerSessionId: string;
      promptId: string;
      outcome: Readonly<{
        kind: 'completed' | 'cancelled' | 'failed';
        message?: string;
      }>;
    }>): boolean;
  }>;
}>;

export type AcpExtensionContextFactory = (
  method: string,
  sdkSignal: AbortSignal,
  requestId?: string | number,
) => AcpExtensionHandlerContext;

export type AcpExtensionRegistration = Readonly<{
  kind: 'request' | 'notification';
  method: string;
  register: (app: ClientApp, createContext: AcpExtensionContextFactory) => void;
}>;

function parseExtensionParams<Params>(parser: ParamsParser<Params>, value: unknown): Params {
  try {
    return typeof parser === 'function' ? parser(value) : parser.parse(value);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw RequestError.invalidParams({ details: 'Extension parameters failed validation' });
  }
}

function wrapExtensionParamsParser<Params>(parser: ParamsParser<Params>): ParamsParser<Params> {
  return { parse: (value) => parseExtensionParams(parser, value) };
}

export function defineAcpExtensionRequest<Params, Response>(
  definition: Readonly<{
    method: string;
    params: ParamsParser<Params>;
    handler: (
      params: Params,
      context: AcpExtensionHandlerContext,
    ) => Response | Promise<Response>;
  }>,
): AcpExtensionRegistration {
  return {
    kind: 'request',
    method: definition.method,
    register: (app, createContext) => {
      app.onRequest(definition.method, wrapExtensionParamsParser(definition.params), (context) => (
        definition.handler(
          context.params,
          createContext(definition.method, context.signal, context.requestId ?? undefined),
        )
      ));
    },
  };
}

export function defineAcpExtensionNotification<Params>(definition: Readonly<{
  method: string;
  params: ParamsParser<Params>;
  handler: (
    params: Params,
    context: AcpExtensionHandlerContext,
  ) => void | Promise<void>;
}>): AcpExtensionRegistration {
  return {
    kind: 'notification',
    method: definition.method,
    register: (app, createContext) => {
      app.onNotification(definition.method, wrapExtensionParamsParser(definition.params), (context) => (
        definition.handler(context.params, createContext(definition.method, context.signal))
      ));
    },
  };
}

export type AcpClientConnectionOptions = Readonly<{
  name: string;
  transport: AcpClientTransport;
  handlers: AcpClientConnectionHandlers;
  extensions?: ReadonlyArray<AcpExtensionRegistration>;
  createExtensionContext?: AcpExtensionContextFactory;
}>;
