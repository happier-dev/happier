# `@happier-dev/database-protocol`

Versioned database workbench business schemas shared by the workbench, engine
implementations, deployment transports, UI, CLI and plugin SDK projections.
This is unreleased 0.3 development source.

Import the current contract from `@happier-dev/database-protocol/v1`; the base
entrypoint exposes the same producers. Credential-free fixtures are available
from `@happier-dev/database-protocol/testing/v1`. The package contains no SQL,
driver, permission policy, credential acquisition, persistence or connection
lifecycle.

Targets identify existing worktree, deployment or Project Saved Secret owners.
They carry no connection URL. Operation inputs select one target, and may name
an existing demand `subscriptionId`; this is connection reuse context, never
an authorization grant. Access admission remains with the access owner and
the existing Action executor.

Target listing accepts a Project scope to include its existing manual associations
across worktrees on the selected installation. Connect still selects a concrete
worktree or Environment scope. Listing reads association metadata without opening
connections or acquiring Saved Secrets.

Integer, decimal and JSON values retain their original text. SQL NULL and JSON
null have different tags (`{ type: 'null' }` and `{ type: 'json', value: 'null' }`).
Rows and columns are ordered arrays so duplicate column labels and zero-row
metadata survive. A partial cell carries its encoding and byte range; incomplete
results carry a reason and a continuation when the executor can provide one.
Arbitrary SQL continuation is an explicit non-snapshot rerun operand. No output
allowance, shared model cap, retained cursor or retry policy is introduced.

## Evolving the ABI

Follow the [protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution).
Wire epoch **v1** is separate from package version **0.0.0**. Every structured
target, operation, result and nested metadata envelope is closed; unknown fields
are rejected rather than dropped or preserved. JSON Explain plans are JSON
payload data, not routing, authority or executable declarations.
Native/platform cause codes and contributed engine identities are strings owned
by their external producer, not extensions to the operation union.

New authority-bearing operation/target union members require a new epoch or the
doctrine's explicitly approved development direct cut. There is no historical
Database workbench writer or stored Database record to migrate in this initial
package. Supported deployment query callers migrate at their owning integration
boundary; this package does not add a legacy mapper. Package tests prove pure
schema contracts only, never execution, authorization or composed-flow behavior.
