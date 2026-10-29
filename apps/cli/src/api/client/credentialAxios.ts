import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { assertCredentialRequestRedirectAllowed, CREDENTIAL_REQUEST_REDIRECT_POLICY } from '@happier-dev/cli-common/homeTarget';
import { readHttpStatus } from './httpStatusError';

function refuseRedirects(config: AxiosRequestConfig | undefined): AxiosRequestConfig {
  return {
    ...config,
    maxRedirects: CREDENTIAL_REQUEST_REDIRECT_POLICY.maxRedirects,
    fetchOptions: { ...config?.fetchOptions, redirect: CREDENTIAL_REQUEST_REDIRECT_POLICY.redirect },
  };
}

async function settle(response: Promise<AxiosResponse<unknown>>): Promise<AxiosResponse<unknown>> {
  try {
    const result = await response;
    assertCredentialRequestRedirectAllowed(result.status);
    return result;
  } catch (error) {
    // Both Axios validateStatus branches must produce the same secret-free error.
    const status = readHttpStatus(error);
    if (status !== null) assertCredentialRequestRedirectAllowed(status);
    throw error;
  }
}

const bodyMethods = new Set(['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm']);
const readMethods = new Set(['get', 'delete', 'head', 'options']);

/** Preserve the Axios API and its existing proxy/authority interceptors at one boundary. */
function credentialClient<T extends AxiosInstance>(client: T): T {
  const methods = new Map<PropertyKey, unknown>();
  const request = (args: unknown[]) => {
    const [first, second] = args;
    const config = typeof first === 'string'
      ? { ...(second as AxiosRequestConfig | undefined), url: first }
      : first as AxiosRequestConfig;
    return settle(client.request(refuseRedirects(config)));
  };
  return new Proxy(client, {
    apply(_target, _receiver, args: unknown[]) { return request(args); },
    get(target, key, receiver): unknown {
      if (methods.has(key)) return methods.get(key);
      let method: unknown;
      if (key === 'request') method = (...args: unknown[]) => request(args);
      else if (key === 'create') method = (config?: AxiosRequestConfig) => credentialClient(
        Reflect.apply(Reflect.get(target, key), target, [refuseRedirects(config)]) as AxiosInstance,
      );
      else if (typeof key === 'string' && (bodyMethods.has(key) || readMethods.has(key))) {
        method = (...args: unknown[]) => {
          const configIndex = bodyMethods.has(key) ? 2 : 1;
          args[configIndex] = refuseRedirects(args[configIndex] as AxiosRequestConfig | undefined);
          // Axios owns these public method signatures; the decorator changes only config.
          return settle(Reflect.apply(Reflect.get(target, key), target, args) as Promise<AxiosResponse<unknown>>);
        };
      } else return Reflect.get(target, key, receiver);
      methods.set(key, method);
      return method;
    },
  });
}

export default credentialClient(axios);
