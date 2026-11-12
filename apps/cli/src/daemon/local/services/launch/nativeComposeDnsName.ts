/** Docker registers the 12-character container ID as an endpoint DNS name on
 * user-defined networks (Moby buildEndpointDNSNames). Keep ordinary names,
 * but use that native alias when a Compose name exceeds DNS's label limit. */
export function nativeComposeContainerDnsName(id: string, name: string): string {
    return name.length <= 63 ? name : id.slice(0, 12);
}
