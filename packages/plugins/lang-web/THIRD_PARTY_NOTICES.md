# Language server acquisition

Development source declares `vscode-langservers-extracted@4.10.0`, licensed MIT:
https://github.com/hrsh7th/vscode-langservers-extracted/tree/v4.10.0.
It contains Microsoft's JSON/CSS/HTML servers and uses the package's published dependency graph.
The managed installer retains package license files and disables lifecycle scripts.
No server package is downloaded when opening a file. Install the declared dependency
through the normal Machine plugin/dependency flow before using it.
