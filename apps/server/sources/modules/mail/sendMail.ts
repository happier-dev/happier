import { createTransport } from "nodemailer";

/** An SMTP server to send through. `password` is null when the server needs no login. */
export interface SmtpSettings {
    readonly host: string;
    readonly port: number;
    /** `tls`: TLS from the start (usually 465). `starttls`: upgrade after connecting (usually 587). */
    readonly security: "tls" | "starttls" | "none";
    readonly username: string;
    readonly password: string | null;
    readonly fromAddress: string;
}

export interface MailMessage {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
}

/**
 * Sends a plain-text email through the given SMTP server.
 * Throws when the SMTP server cannot be reached or rejects the message.
 */
export async function sendMail(settings: SmtpSettings, message: MailMessage): Promise<void> {
    const transport = createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.security === "tls",
        requireTLS: settings.security === "starttls",
        ignoreTLS: settings.security === "none",
        auth: settings.username ? { user: settings.username, pass: settings.password ?? "" } : undefined,
    });
    try {
        await transport.sendMail({
            from: settings.fromAddress,
            to: message.to,
            subject: message.subject,
            text: message.text,
        });
    } finally {
        transport.close();
    }
}
