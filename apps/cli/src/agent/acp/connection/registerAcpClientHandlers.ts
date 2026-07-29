import { methods, type ClientApp } from '@agentclientprotocol/sdk';

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
    .onNotification(methods.client.session.update, (context) => (
      params.handlers.sessionUpdate(context.params)
    ));

  if (params.handlers.readTextFile) {
    const readTextFile = params.handlers.readTextFile;
    params.app.onRequest(methods.client.fs.readTextFile, (context) => readTextFile(context.params));
  }
  if (params.handlers.writeTextFile) {
    const writeTextFile = params.handlers.writeTextFile;
    params.app.onRequest(methods.client.fs.writeTextFile, (context) => writeTextFile(context.params));
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
