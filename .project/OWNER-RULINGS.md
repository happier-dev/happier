# Owner rulings

## Process and orchestration

| Date | Ruling | Pointer |
|---|---|---|
| 2026-11-04 | **Browser can open product-started services on any port (owner, direct to RU2 ~09:12Z: "I agree with your decision").** A service that Happier itself started or declared on a Machine is admissible through the in-app Browser and previews at whatever port it bound. `HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS` stays the operator rule for arbitrary ports. Decided once at admission; cross-person protection unchanged; Opus security review before ship. | RU2 PORTS-FIX-1104 |
| 2026-11-04 | **Release checks on mac2 and Windows workers (owner, direct to RU2):** run the Mac release checks on mac-host or mac2-host (real macOS; owner logged in at console) and the Windows checks on the remote Windows workers, installing what's needed. Still never click macOS permission prompts or change System Settings/TCC; signing stays with the release owner. | RU2 RC-MAC2-1104, RC-WIN-V20-1104 |
