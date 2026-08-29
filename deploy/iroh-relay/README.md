# Happier Iroh relay

This is a separate stateless relay artifact. The default profile is holepunch-only;
forwarding mode requires an explicit operator rollout and separate capacity/cost evidence.

The Compose service has no persistent data or application-server mounts. It only publishes the
Iroh UDP listener and reads the checked-in configuration. `enable_relay=false` keeps packet
forwarding disabled while `enable_quic_addr_discovery=true` retains rendezvous/address discovery.
Before starting it, provision the operator-managed certificate and key as
`certs/default.crt` and `certs/default.key`; these are mounted read-only and are not relay state.
Do not treat client-observed relay bytes as proof that forwarding is disabled; that property is
validated against the pinned relay process and deployment configuration.
