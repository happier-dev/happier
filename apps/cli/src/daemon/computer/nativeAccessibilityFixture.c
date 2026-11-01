/* Opt-in integration fixture: compile with cc and pkg-config gtk+-3.0 flags,
 * then set HAPPIER_TEST_NATIVE_ACCESSIBILITY_FIXTURE to the executable. */
#include <gtk/gtk.h>
#include <stdio.h>

static void clicked(GtkWidget *widget, gpointer data) {
    (void)widget;
    (void)data;
    puts("clicked");
    fflush(stdout);
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    GtkWidget *button = gtk_button_new_with_label("Probe click");
    gtk_window_set_title(GTK_WINDOW(window), "CU Desktop element probe");
    gtk_container_add(GTK_CONTAINER(window), button);
    g_signal_connect(button, "clicked", G_CALLBACK(clicked), NULL);
    gtk_widget_show_all(window);
    puts("ready");
    fflush(stdout);
    gtk_main();
    return 0;
}
