import { z } from '../zodRuntimePolicy.js';

export const DEFAULT_CLOUDFLARE_TUNNEL_CONNECTORS_PER_MACHINE = 1;
// Cloudflare permits 25 replicas (100 connections) across the entire tunnel.
// https://developers.cloudflare.com/tunnel/configuration/#replicas-and-high-availability
export const CLOUDFLARE_TUNNEL_CONNECTOR_LIMIT = 25;

export const CloudflareTunnelConnectorsPerMachineV1Schema = z.number().check(
    z.int(), z.minimum(DEFAULT_CLOUDFLARE_TUNNEL_CONNECTORS_PER_MACHINE), z.maximum(CLOUDFLARE_TUNNEL_CONNECTOR_LIMIT));
