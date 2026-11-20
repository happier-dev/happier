#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* A native external Claude boundary: the real placement owner copies this ELF
 * just as it copies a vendor executable. The fixture itself does not embed
 * Happier or launch its daemon/Session runner. */
int main(int argc, char **argv) {
    if (argc == 2 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v"))) {
        puts("2.1.292 (Claude Code)");
        return 0;
    }
    if (argc > 2 && !strcmp(argv[1], "auth") && !strcmp(argv[2], "status")) {
        puts("{\"loggedIn\":true}");
        return 0;
    }
    for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--help")) {
        puts("--input-format --output-format --permission-mode");
        return 0;
    }
    if (access("host-sentinel.txt", R_OK) == 0) {
        FILE *source = fopen("host-sentinel.txt", "r");
        FILE *observed = fopen("agent-observed.txt", "w");
        if (!source || !observed) return 2;
        int byte;
        while ((byte = fgetc(source)) != EOF) fputc(byte, observed);
        fclose(source);
        fclose(observed);
        FILE *edit = fopen("agent-edit.txt", "w");
        if (!edit) return 3;
        fputs("edit from the sandbox agent\n", edit);
        fclose(edit);
        /* These guest-only control files must never be returned to the host. */
        system("mkdir -p .git/hooks; printf '#!/bin/sh\\nexit 99\\n' > .git/hooks/pre-commit; git config journey.guest true");
    }
    puts("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sandbox-agent-session\",\"tools\":[],\"mcp_servers\":[],\"model\":\"fake\",\"permissionMode\":\"default\"}");
    fflush(stdout);
    char *line = NULL;
    size_t capacity = 0;
    unsigned long turn = 0;
    while (getline(&line, &capacity, stdin) != -1) {
        if (!strstr(line, "\"user\"")) continue;
        turn++;
        /* Correlate accepted-input wake turns without replacing any Happier
         * provider, transport, enrollment or transcript behavior. */
        const char *token = strstr(line, "WAKE_");
        if (!token) token = strstr(line, "BARRIER_");
        if (!token) token = strstr(line, "REBUILT_");
        if (token) {
            int length = (int)strspn(token, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
            printf("{\"type\":\"assistant\",\"session_id\":\"sandbox-agent-session\",\"message\":{\"id\":\"sandbox-%ld-%lu\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"fake\",\"content\":[{\"type\":\"text\",\"text\":\"%.*s\"}],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n", (long)getpid(), turn, length, token);
            printf("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"%.*s\",\"session_id\":\"sandbox-agent-session\",\"duration_ms\":1,\"duration_api_ms\":1,\"num_turns\":1,\"total_cost_usd\":0,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n", length, token);
            fflush(stdout);
            continue;
        }
        puts("{\"type\":\"assistant\",\"session_id\":\"sandbox-agent-session\",\"message\":{\"id\":\"sandbox-message\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"fake\",\"content\":[{\"type\":\"text\",\"text\":\"Observed and edited sandbox files\"}],\"stop_reason\":\"end_turn\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}");
        puts("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Observed and edited sandbox files\",\"session_id\":\"sandbox-agent-session\",\"duration_ms\":1,\"duration_api_ms\":1,\"num_turns\":1,\"total_cost_usd\":0,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}");
        fflush(stdout);
    }
    free(line);
    return 0;
}
