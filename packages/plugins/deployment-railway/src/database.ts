import type { DeploymentTargetDatabaseRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { DatabaseDescriptorV1, DatabaseManagedDeploymentTargetV1 } from '@happier-dev/plugin-sdk/database';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { builtinDatabaseCapabilities } from '@happier-dev/databases/capabilities';
import { parseDatabaseConnectionUrl } from '@happier-dev/databases/connection';
import { engines, railway, readFailure, selectedService, type Engine, type Scope } from './provider.js';

function descriptor(engine: Engine, target: DatabaseManagedDeploymentTargetV1,
  placement: DatabaseDescriptorV1['placement']): DatabaseDescriptorV1 {
  return { target, placement, engine, label: target.database, origin: { label: 'Railway' },
    capabilities: [...builtinDatabaseCapabilities(engine)] };
}

/** The selected service's private address; it names the engine and database. */
async function privateAddress(engine: Engine, preparation: Scope, context: PluginAccountActionContext) {
  const value = await railway(context).project.readServiceVariable(selectedService(preparation), engines[engine].privateVariable).catch(readFailure);
  if (!value) return null;
  try {
    const parsed = parseDatabaseConnectionUrl(value);
    return parsed.engine === engine && parsed.hostname ? { value, database: parsed.database } : null;
  } catch {
    return null;
  }
}

export function railwayDatabaseRuntime(engine: Engine): DeploymentTargetDatabaseRuntimeV1 {
  return {
    async readRoleEndpoint({ preparation }, context) {
      const service = selectedService(preparation);
      const address = await privateAddress(engine, preparation, context);
      if (!address) throw new PluginError({ code: 'database_connection_unavailable' });
      const proxies = await railway(context).project.listTcpProxies(service).catch(readFailure);
      const proxy = proxies.find(candidate => candidate.applicationPort === engines[engine].port);
      if (!proxy) throw new PluginError({ code: 'database_public_networking_required',
        message: 'Turn on Public Networking for this database service in Railway, then try again.' });
      const url = new URL(address.value);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      url.hostname = proxy.domain;
      url.port = String(proxy.proxyPort);
      // Railway's database templates sign their certificate with a CA generated inside the
      // container, for private names only. The public proxy keeps TLS but cannot prove the
      // server's identity (owner decision 2026-11-23).
      return { connectionString: url.toString(), trust: 'encrypted_unverified' };
    },
    async listTargets({ preparation, target, placement }, context) {
      const database = (await privateAddress(engine, preparation, context))?.database;
      if (!database) return { targets: [], completeness: { complete: false, reason: 'transport_unproven' } };
      return { targets: [descriptor(engine, { ...target, database }, placement)], completeness: { complete: true } };
    },
    async open({ target, placement, access }, context) {
      // The host reads through `readRoleEndpoint` with the limited login.
      if (access !== 'write') throw new PluginError({ code: 'database_transport_unavailable',
        message: 'Railway reads require a limited database login.' });
      const readRole = context.services.secrets.readDataRole;
      if (!readRole) throw new PluginError({ code: 'write_connection_setup_required' });
      const engines = context.services.databaseEngines;
      if (!engines) throw new PluginError({ code: 'plugin_service_unavailable' });
      const connectionString = await readRole({ role: 'write', signal: context.signal });
      const connection = await engines.open(engine, { connectionString, access, signal: context.signal });
      return { descriptor: descriptor(engine, target, placement), connection };
    },
  };
}
