/** Host-private members of the existing signed broker application. They are not
 * part of a Provider's `/v1` surface and never reach Provider dispatch. */
export const PROVIDER_BROKER_PRIVATE_CLOSE_PATH =
  '/v1/_happier/provider-broker/close' as const;
export const PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH =
  '/v1/_happier/provider-broker/endpoint' as const;
export const PROVIDER_BROKER_ENDPOINT_PATH_HEADER =
  'x-happier-provider-endpoint-path' as const;
