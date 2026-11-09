import { methods, type ClientApp, type SessionNotification } from '@agentclientprotocol/sdk';

import type {
  AcpClientConnectionHandlers,
  AcpExtensionContextFactory,
  AcpExtensionRegistration,
} from './types';

export function registerAcpClientHandlers(params: Readonly<{
  app: ClientApp;
  handlers: AcpClientConnectionHandlers;
  extensions: ReadonlyArray<AcpExtensionRegistration>;
  createExtensionContext: AcpExtensionContextFactory;
}>): void {
  params.app
    .onRequest(methods.client.session.requestPermission, (context) => (
      params.handlers.requestPermission(context.params)
    ))
    .onNotification(
      methods.client.session.update,
      // SDK 1.2.1's always-on SessionUpdateRouter validates this notification
      // before registered handlers, but its default second parse drops the
      // standard tool_call.name field. Valid update fields need no rewriting.
      // Preserve the validated raw value until the SDK's schema retains name;
      // malformed-frame rejection is pinned by the real connection test.
      (value: unknown) => value as SessionNotification,
      (context) => params.handlers.sessionUpdate(context.params),
    );

  if (params.handlers.readTextFile) {
    const readTextFile = params.handlers.readTextFile;
    params.app.onRequest(methods.client.fs.readTextFile, (context) => readTextFile(context.params));
  }
  if (params.handlers.writeTextFile) {
    const writeTextFile = params.handlers.writeTextFile;
    params.app.onRequest(methods.client.fs.writeTextFile, (context) => writeTextFile(context.params));
  }
  if (params.handlers.createElicitation) {
    const createElicitation = params.handlers.createElicitation;
    params.app.onRequest(methods.client.elicitation.create, (context) => (
      createElicitation(context.params, { signal: context.signal })
    ));
  }

  const registrationKeys = new Set<string>();
  for (const extension of params.extensions) {
    const key = `${extension.kind}:${extension.method}`;
    if (registrationKeys.has(key)) {
      throw new Error(`Duplicate ACP extension ${extension.kind} registration: ${extension.method}`);
    }
    registrationKeys.add(key);
    extension.register(params.app, params.createExtensionContext);
  }
}
